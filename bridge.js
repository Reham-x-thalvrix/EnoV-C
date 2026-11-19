(() => {
  const FLAG = "__enovBridgeRan";
  if (window[FLAG]) return;
  window[FLAG] = true;

  const inject = () => {
    if (document.querySelector('script[data-enov]')) return;
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('enov-core.js');
    s.dataset.enov = "1";
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  };

if (document.head) inject();
  else {
    const mo = new MutationObserver(() => {
      if (document.head) { mo.disconnect(); inject(); }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
