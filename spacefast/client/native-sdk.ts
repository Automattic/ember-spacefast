// Named operations share two native entrypoints so the platform stores the
// guarded server bundle once per dispatcher rather than once per operation.
// The native SDK still owns auth, query caching, subscriptions and mutation IO.
import {useCallback} from 'react';
import {useQuery as useNativeQuery,useMutation as useNativeMutation} from '@spacefast/zero/react';
export {useAuth,signInWithGoogle,signInWithSpacefast,signOut,storage} from '@spacefast/zero/react';
export function useQuery<TResult=unknown,TArgs extends unknown[]=unknown[]>(operation:string,...args:TArgs):TResult|undefined {
 return useNativeQuery<TResult>('read',operation,args);
}
export function useMutation<TArgs extends unknown[]=unknown[],TResult=unknown>(operation:string):(...args:TArgs)=>Promise<TResult>{
 const write=useNativeMutation<[string,unknown[]],TResult>('write');
 return useCallback((...args:TArgs)=>write(operation,args),[write,operation]);
}
