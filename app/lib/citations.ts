// Turns a model-emitted "[N]" citation marker into a link to that turn's
// Nth source card in RightSidebar (id `source-${messageId}-${N-1}`, set up
// in ChatArea's fetch handler and RightSidebar's rendering). The negative
// lookahead for "(" avoids clobbering markdown link syntax like
// "[text](url)" - a real citation marker is bare digits in brackets with
// nothing following, never itself part of a link.
export function linkifyCitations(text: string, messageId: string): string {
  return text.replace(/\[(\d+)\](?!\()/g, (_match, num: string) => {
    const index = Number(num) - 1;
    return `<sup><a href="#source-${messageId}-${index}" class="citation-link">[${num}]</a></sup>`;
  });
}
