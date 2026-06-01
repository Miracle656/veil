// Background Service Worker for Veil Wallet Extension

// Enable opening the side panel when clicking the extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting panel behavior:", error));

// Track connected sidepanel ports or direct messages
let sidepanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "veil-sidepanel") {
    sidepanelPort = port;
    console.log("Side panel connected.");

    port.onDisconnect.addListener(() => {
      sidepanelPort = null;
      console.log("Side panel disconnected.");
    });
  }
});

// Listen for messages from content scripts or sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Background received message:", message, "from:", sender);

  // 1. Message from content script: Active page reporting state or events
  if (message.type === "VEIL_PAGE_EVENT" || message.type === "VEIL_PAGE_INFO") {
    // Forward to side panel if open
    if (sidepanelPort) {
      sidepanelPort.postMessage({
        type: "PAGE_CHANGED",
        data: {
          title: message.title || (sender.tab ? sender.tab.title : "Unknown Page"),
          url: message.url || (sender.tab ? sender.tab.url : ""),
          origin: message.origin || (sender.tab ? new URL(sender.tab.url).origin : ""),
          tabId: sender.tab ? sender.tab.id : null,
          details: message.details || {}
        }
      });
    }
    sendResponse({ status: "forwarded" });
    return true;
  }

  // 2. Message from side panel: Send message to active page's content script
  if (message.type === "SEND_TO_PAGE") {
    const { tabId, payload } = message;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, payload, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("Could not send message to tab:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, response });
        }
      });
      return true; // Keep channel open for async response
    } else {
      // Find active tab and send
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, payload, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true, response });
            }
          });
        } else {
          sendResponse({ success: false, error: "No active tab found" });
        }
      });
      return true;
    }
  }

  // 3. Side panel requesting the current active tab information
  if (message.type === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        sendResponse({
          title: tabs[0].title,
          url: tabs[0].url,
          id: tabs[0].id
        });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true;
  }

  // 4. Handle proxy requests or other wallet message pass-throughs
  if (message.type === "VEIL_WALLET_REQUEST") {
    // Simulate routing or processing transactions, or delegate to side panel
    if (sidepanelPort) {
      sidepanelPort.postMessage({
        type: "WALLET_ACTION_REQUEST",
        payload: message.payload,
        senderTabId: sender.tab ? sender.tab.id : null
      });
      sendResponse({ status: "pending_sidepanel_approval" });
    } else {
      sendResponse({ error: "Veil Wallet panel is not open. Please click the extension icon to open it." });
    }
    return true;
  }
});

// Broadcast active tab updates to sidepanel when tab selection changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (sidepanelPort) {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
        sidepanelPort.postMessage({
          type: "PAGE_CHANGED",
          data: {
            title: tab.title,
            url: tab.url,
            origin: new URL(tab.url).origin,
            tabId: tab.id
          }
        });
      }
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (sidepanelPort && changeInfo.status === "complete" && tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
    sidepanelPort.postMessage({
      type: "PAGE_CHANGED",
      data: {
        title: tab.title,
        url: tab.url,
        origin: new URL(tab.url).origin,
        tabId: tab.id
      }
    });
  }
});
