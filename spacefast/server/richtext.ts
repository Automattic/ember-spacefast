import { prepareBody, userIdsIn } from './vendor/ember-richtext';
// Exact upstream sanitizer, prebundled locally to respect Zero server import boundaries.
export function sanitizeBody(value: unknown, resolve: (id:string)=>{id:string;name:string}|undefined = () => undefined): {body:string;plainText:string;mentions:Array<{id:string;name:string}>} {
 if(typeof value !== 'string' || value.length > 100000) throw new Error('Invalid message body.');
 const prepared = prepareBody(value, resolve);
 if(!prepared || prepared.blank) return {body:'',plainText:'',mentions:[]};
 if(prepared.plainText.length>20000) throw new Error('Message too long.');
 return {body:prepared.html,plainText:prepared.plainText,mentions:prepared.mentions};
}

export {userIdsIn};
