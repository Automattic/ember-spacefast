export function plainTextFromHtml(body: string) {
  const document = new DOMParser().parseFromString(body, "text/html");
  document.querySelectorAll("br, p, div, li, blockquote, pre").forEach(element => {
    element.after(document.createTextNode("\n"));
  });
  return document.body.textContent?.trim() ?? "";
}
