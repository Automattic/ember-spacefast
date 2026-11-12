import {useRef,useLayoutEffect,useCallback} from 'react';
export function useEffectEvent<T extends (...args:any[])=>any>(callback:T):T {const ref=useRef(callback);useLayoutEffect(()=>{ref.current=callback;});return useCallback(((...args:any[])=>ref.current(...args)) as T,[]);}
