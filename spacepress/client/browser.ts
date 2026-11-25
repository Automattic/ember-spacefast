import "../../spacefast/client/browser-entry";

const container = document.getElementById("ember-native-app");
if (container) {
  // WordPress canonical URLs can end in a slash. Ember routes use slashless paths.
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (path !== location.pathname) history.replaceState(history.state, "", path + location.search + location.hash);
  const mount = (window as Window & { __mountNativeEmber?: (element: HTMLElement) => void }).__mountNativeEmber;
  mount?.(container);
}
