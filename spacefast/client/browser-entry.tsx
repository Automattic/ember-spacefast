import {createRoot, type Root} from 'react-dom/client';
import {App} from './ember/App';
import {NativeTransport} from './native-transport';
import {emberStyles} from './ember-styles';
import { initializeWebAppInstallation } from './ember/lib/web-app-installation';

initializeWebAppInstallation();
const roots=new Map<HTMLElement,Root>();
const nativeStyles=new Map<HTMLLinkElement,boolean>();
let observer:MutationObserver|undefined;
function isolateStyles(){const disable=()=>{for(const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')){if(new URL(link.href,location.href).pathname==='/zero.css'){if(!nativeStyles.has(link))nativeStyles.set(link,link.disabled);link.disabled=true;}}};disable();observer??=new MutationObserver(disable);observer.observe(document.head,{childList:true,subtree:true});}
function restoreStyles(){observer?.disconnect();observer=undefined;for(const[link,disabled]of nativeStyles)link.disabled=disabled;nativeStyles.clear();}
(window as any).__mountNativeEmber=(container:HTMLElement)=>{if(roots.has(container))return;isolateStyles();const root=createRoot(container);roots.set(container,root);root.render(<><style>{emberStyles}</style><NativeTransport/><App/></>);};
(window as any).__unmountNativeEmber=(container:HTMLElement)=>{roots.get(container)?.unmount();roots.delete(container);if(!roots.size)restoreStyles();};
