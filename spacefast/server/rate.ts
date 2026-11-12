import type {Writer} from './access';
/** Committed with the protected write. Per-actor counters reset in fixed time windows. */
export async function consumeRate(ctx:Writer,actorId:string,kind:string,limit:number,periodMs:number,cost=1) {
 const now=Date.now();const window=String(Math.floor(now/periodMs));const key=actorId+':'+kind;const row=await ctx.db.rateLimits.withIndex('by_key',q=>q.eq('key',key)).first();const used=row?.window===window?Number(row.count):0;if(!Number.isFinite(cost)||cost<1||used+cost>limit)throw new Error('Too many requests. Please try again later.');if(row)await ctx.db.rateLimits.update(row.id,{window,count:String(used+cost)});else await ctx.db.rateLimits.insert({key,window,count:String(cost)});
}
