// Wrap in a function to avoid redeclaring in global scope
(function() {
  //Selects the messageId from the DOM
  const msgEl = document.querySelector('[data-legacy-message-id]');
  if (msgEl) {
    const messageId = msgEl.getAttribute('data-legacy-message-id');
    chrome.runtime.sendMessage({ messageId });
  } else {
    chrome.runtime.sendMessage({ error: "No message element found on page." });
  }
})();

