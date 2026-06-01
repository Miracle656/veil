// Content Script for Veil Wallet Extension
console.log("Veil Wallet content script injected.");

// Report active page load info to background script
try {
  chrome.runtime.sendMessage({
    type: "VEIL_PAGE_INFO",
    title: document.title,
    url: window.location.href,
    origin: window.location.origin
  }, (response) => {
    // Suppress errors if extension background is sleeping or not loaded
    if (chrome.runtime.lastError) {
      // Ignore
    }
  });
} catch (e) {
  // Ignore
}

// Create a nice styled toast function to display on-page notifications
function showOnPageToast(message, type = "success") {
  // Check if style already injected
  let styleId = "veil-toast-styles";
  if (!document.getElementById(styleId)) {
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .veil-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #0f172a;
        color: #f8fafc;
        padding: 14px 20px;
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        border: 1px solid #1e293b;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        z-index: 999999;
        display: flex;
        align-items: center;
        gap: 10px;
        transform: translateY(100px);
        opacity: 0;
        transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        max-width: 350px;
      }
      .veil-toast.show {
        transform: translateY(0);
        opacity: 1;
      }
      .veil-toast-icon {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        font-weight: bold;
        font-size: 11px;
        flex-shrink: 0;
      }
      .veil-toast-success .veil-toast-icon {
        background: #10b981;
        color: #0f172a;
      }
      .veil-toast-info .veil-toast-icon {
        background: #3b82f6;
        color: #ffffff;
      }
      .veil-toast-warning .veil-toast-icon {
        background: #f59e0b;
        color: #0f172a;
      }
      .veil-toast-close {
        margin-left: auto;
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 0.2s;
        border: none;
        background: none;
        color: inherit;
        font-size: 16px;
        padding: 0 0 0 8px;
      }
      .veil-toast-close:hover {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  // Remove existing toast if any
  const existing = document.querySelector(".veil-toast");
  if (existing) {
    existing.remove();
  }

  // Create new toast
  const toast = document.createElement("div");
  toast.className = `veil-toast veil-toast-${type}`;
  
  const iconText = type === "success" ? "✓" : type === "info" ? "i" : "⚠";
  toast.innerHTML = `
    <span class="veil-toast-icon">${iconText}</span>
    <span style="flex-grow: 1; line-height: 1.4;">${message}</span>
    <button class="veil-toast-close">&times;</button>
  `;

  document.body.appendChild(toast);

  // Trigger animation
  setTimeout(() => toast.classList.add("show"), 10);

  // Close event
  toast.querySelector(".veil-toast-close").addEventListener("click", () => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 400);
  });

  // Auto remove
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 400);
    }
  }, 5000);
}

// Listen for messages from the background script / side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Content script received message:", message);

  if (message.type === "PING") {
    sendResponse({ status: "PONG", title: document.title, url: window.location.href });
    return true;
  }

  if (message.type === "DISPLAY_TOAST") {
    showOnPageToast(message.text, message.toastType || "success");
    sendResponse({ success: true });
    return true;
  }

  if (message.type === "HIGHLIGHT_ELEMENTS") {
    // Simple visual feedback: Flash all buttons on the page to demonstrate interaction!
    const buttons = document.querySelectorAll("button, a.btn, input[type='submit']");
    buttons.forEach((btn) => {
      const originalOutline = btn.style.outline;
      const originalTransition = btn.style.transition;
      btn.style.transition = "outline 0.3s ease";
      btn.style.outline = "3px solid #6366f1";
      setTimeout(() => {
        btn.style.outline = originalOutline;
        setTimeout(() => {
          btn.style.transition = originalTransition;
        }, 300);
      }, 1500);
    });

    showOnPageToast(`Highlighted ${buttons.length} actionable elements on this page!`, "info");
    sendResponse({ success: true, count: buttons.length });
    return true;
  }

  if (message.type === "MOCK_TRANSACTION_SIGN") {
    // Show a mock confirmation modal on-page or just toast it
    showOnPageToast(`Signing request for transaction ${message.txHash.slice(0, 8)}... via Veil Extension`, "info");
    
    // Simulate user interaction delay
    setTimeout(() => {
      showOnPageToast(`Successfully signed transaction!`, "success");
      sendResponse({ success: true, signature: "mock_signature_from_webauthn_" + Math.random().toString(36).substring(2) });
    }, 1500);

    return true; // Keep message channel open for async response
  }
});

// Bridge postMessage requests from the actual web page to the extension
// This enables any dApp page to do: window.postMessage({ type: "VEIL_CONNECT" }, "*")
window.addEventListener("message", (event) => {
  // Only accept messages from the same window
  if (event.source !== window) return;

  const msg = event.data;
  if (msg && typeof msg === "object" && msg.type && msg.type.startsWith("VEIL_")) {
    console.log("Content script caught postMessage from page:", msg);

    // Relay to background script which can forward to sidepanel
    chrome.runtime.sendMessage({
      type: "VEIL_WALLET_REQUEST",
      payload: msg
    }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: msg.type + "_RESPONSE",
          error: "Extension background script not reachable."
        }, "*");
      } else {
        window.postMessage({
          type: msg.type + "_RESPONSE",
          response: response
        }, "*");
      }
    });
  }
});
