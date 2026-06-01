// Sidepanel Script for Veil Wallet Extension

// State Management
let currentTabId = null;
let currentTabUrl = "";
let currentTabTitle = "";
let isConnectedToTab = false;

// DOM Elements
const tabTitleEl = document.getElementById("tab-title");
const tabDomainEl = document.getElementById("tab-domain");
const connectionIndicator = document.getElementById("connection-indicator");
const btnConnect = document.getElementById("btn-connect");
const btnPing = document.getElementById("btn-ping");
const btnSendToast = document.getElementById("btn-send-toast");
const btnHighlight = document.getElementById("btn-highlight");
const toastMessageInput = document.getElementById("toast-message");
const logsList = document.getElementById("logs-list");
const btnClearLogs = document.getElementById("btn-clear-logs");

// Wallet DOM Elements
const walletEmptyState = document.getElementById("wallet-state-empty");
const walletConnectedState = document.getElementById("wallet-state-connected");
const walletUsernameInput = document.getElementById("wallet-username");
const btnRegister = document.getElementById("btn-register");
const btnLogin = document.getElementById("btn-login");
const btnDeploy = document.getElementById("btn-deploy");
const btnSignPayload = document.getElementById("btn-sign-payload");
const btnReset = document.getElementById("btn-reset");
const walletAddressStr = document.getElementById("wallet-address-str");
const walletUserDisplay = document.getElementById("wallet-user-display");
const contractDeployStatus = document.getElementById("contract-deploy-status");
const btnCopyAddress = document.getElementById("btn-copy-address");

// Helper: Logging to Sidepanel UI console
function addLog(message, type = "info") {
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.innerHTML = `[${timestamp}] ${message}`;
  logsList.appendChild(entry);
  logsList.scrollTop = logsList.scrollHeight;
}

// Helper: Shorten Address
function shortenAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
}

// ── 1. Chrome Extension Port & Message Passing ───────────────────────────────

// Connect port to background for persistent stream
const port = chrome.runtime.connect({ name: "veil-sidepanel" });

// Listen for tab changed/updated events from background script
port.onMessage.addListener((message) => {
  if (message.type === "PAGE_CHANGED") {
    const { title, url, origin, tabId } = message.data;
    handleActiveTabChange(title, url, tabId);
  }
  
  if (message.type === "WALLET_ACTION_REQUEST") {
    addLog(`[incoming] Wallet request received from tab: ${JSON.stringify(message.payload)}`, "recv");
    addLog("Prompting user signature validation...", "info");
    
    // Simulate approval UI modal triggers
    if (localStorage.getItem("veil_address")) {
      setTimeout(() => {
        addLog(`✅ Request Auto-Approved using stored Veil credentials!`, "success");
      }, 1000);
    } else {
      addLog(`❌ Request Rejected: No active Veil wallet registered.`, "error");
    }
  }
});

// Update the active tab display
function handleActiveTabChange(title, url, tabId) {
  currentTabId = tabId;
  currentTabUrl = url;
  currentTabTitle = title;
  
  if (!url) {
    tabTitleEl.textContent = "No Active Tab";
    tabDomainEl.textContent = "N/A";
    disableTabActions();
    return;
  }

  // Parse domain
  let domain = "N/A";
  try {
    const parsedUrl = new URL(url);
    domain = parsedUrl.hostname;
    
    // Disable extension options on browser internal pages
    if (parsedUrl.protocol === "chrome:" || parsedUrl.protocol === "chrome-extension:") {
      tabTitleEl.textContent = "Browser Settings / Extension Page";
      tabDomainEl.textContent = domain;
      disableTabActions();
      addLog(`[tab] Navigated to restricted page: ${domain}. Content scripts are inactive here.`, "warning");
      return;
    }
  } catch (e) {
    domain = "Invalid URL";
  }

  tabTitleEl.textContent = title || "Untitled Page";
  tabDomainEl.textContent = domain;
  
  // Every time tab changes, reset connection status to require explicit connection
  // this models the dApp permission handshake model.
  setTabConnectionState(false);
  
  addLog(`[tab] Browser focus switched to: ${domain}`, "info");
}

function setTabConnectionState(connected) {
  isConnectedToTab = connected;
  if (connected) {
    connectionIndicator.textContent = "Connected";
    connectionIndicator.className = "connection-status connected";
    btnConnect.textContent = "Disconnect Site";
    btnConnect.className = "btn btn-outline-danger btn-sm";
    
    btnPing.disabled = false;
    btnSendToast.disabled = false;
    btnHighlight.disabled = false;
  } else {
    connectionIndicator.textContent = "Not Connected";
    connectionIndicator.className = "connection-status disconnected";
    btnConnect.textContent = "Connect to Site";
    btnConnect.className = "btn btn-primary btn-sm";
    
    btnPing.disabled = true;
    btnSendToast.disabled = true;
    btnHighlight.disabled = true;
  }
}

function disableTabActions() {
  setTabConnectionState(false);
  btnConnect.disabled = true;
}

// Fetch current active tab info on startup
function fetchInitialActiveTab() {
  chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" }, (response) => {
    if (chrome.runtime.lastError) {
      addLog("Error contacting background: " + chrome.runtime.lastError.message, "error");
      return;
    }
    if (response && !response.error) {
      btnConnect.disabled = false;
      handleActiveTabChange(response.title, response.url, response.id);
    } else {
      disableTabActions();
    }
  });
}

// ── 2. Message-Passing Actions ───────────────────────────────────────────────

// Handshake connection with active page
btnConnect.addEventListener("click", () => {
  if (isConnectedToTab) {
    setTabConnectionState(false);
    addLog(`[connection] Terminated connection with ${tabDomainEl.textContent}`, "warning");
  } else {
    setTabConnectionState(true);
    addLog(`[connection] Established secure bridge with ${tabDomainEl.textContent}`, "success");
    
    // Instantly notify content script that the wallet is connected!
    chrome.runtime.sendMessage({
      type: "SEND_TO_PAGE",
      tabId: currentTabId,
      payload: {
        type: "DISPLAY_TOAST",
        text: "Veil Wallet extension connected successfully!",
        toastType: "success"
      }
    });
  }
});

// Ping content script
btnPing.addEventListener("click", () => {
  if (!currentTabId) return;
  addLog(`[ping] Sending ping to content script on tab #${currentTabId}...`, "send");
  
  chrome.runtime.sendMessage({
    type: "SEND_TO_PAGE",
    tabId: currentTabId,
    payload: { type: "PING" }
  }, (response) => {
    if (response && response.success && response.response) {
      const payload = response.response;
      addLog(`[pong] Received response from tab! Title: "${payload.title}" Status: ${payload.status}`, "success");
    } else {
      addLog(`[error] Ping failed: ${response?.error || "No response received"}`, "error");
    }
  });
});

// Send Custom Toast Message
btnSendToast.addEventListener("click", () => {
  const message = toastMessageInput.value.trim();
  if (!message) {
    addLog("Please enter a custom message to send.", "warning");
    return;
  }

  addLog(`[toast] Sending toast payload: "${message}"`, "send");
  
  chrome.runtime.sendMessage({
    type: "SEND_TO_PAGE",
    tabId: currentTabId,
    payload: {
      type: "DISPLAY_TOAST",
      text: message,
      toastType: "info"
    }
  }, (response) => {
    if (response && response.success) {
      addLog(`[toast] Successfully displayed on active tab!`, "success");
      toastMessageInput.value = "";
    } else {
      addLog(`[error] Toast failed: ${response?.error || "Content script unreachable."}`, "error");
    }
  });
});

// Highlight Elements on active tab
btnHighlight.addEventListener("click", () => {
  if (!currentTabId) return;
  addLog("[action] Requesting button highlights on active page...", "send");

  chrome.runtime.sendMessage({
    type: "SEND_TO_PAGE",
    tabId: currentTabId,
    payload: { type: "HIGHLIGHT_ELEMENTS" }
  }, (response) => {
    if (response && response.success && response.response) {
      addLog(`[action] Highlight successful. Highlighted ${response.response.count} actionable components!`, "success");
    } else {
      addLog(`[error] Action failed: ${response?.error || "Unreachable page context"}`, "error");
    }
  });
});

// Clear Logs button
btnClearLogs.addEventListener("click", () => {
  logsList.innerHTML = "";
  addLog("Logs cleared.", "info");
});


// ── 3. Wallet Operations (WebAuthn / Soroban Simulations) ────────────────────

// Check stored wallet state on load
function initWalletUI() {
  const storedAddress = localStorage.getItem("veil_address");
  const storedUser = localStorage.getItem("veil_username");
  const storedDeployed = localStorage.getItem("veil_deployed") === "true";

  if (storedAddress) {
    walletAddressStr.textContent = shortenAddress(storedAddress);
    walletAddressStr.dataset.fullAddress = storedAddress;
    walletUserDisplay.textContent = storedUser || "unknown";
    
    if (storedDeployed) {
      contractDeployStatus.textContent = "Deployed";
      contractDeployStatus.className = "contract-status badge-success";
      btnDeploy.disabled = true;
      btnSignPayload.disabled = false;
    } else {
      contractDeployStatus.textContent = "Unregistered Contract";
      contractDeployStatus.className = "contract-status connection-status disconnected";
      btnDeploy.disabled = false;
      btnSignPayload.disabled = true;
    }

    walletEmptyState.classList.add("hidden");
    walletConnectedState.classList.remove("hidden");
  } else {
    walletEmptyState.classList.remove("hidden");
    walletConnectedState.classList.add("hidden");
  }
}

// Generate deterministic mock Soroban/Stellar contract address
function generateMockSorobanAddress(username) {
  // Let's create a realistic contract address starting with 'C' followed by 55 alphanumeric characters
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // Base32
  let hashStr = "C";
  for (let i = 0; i < 55; i++) {
    const charCode = username.charCodeAt(i % username.length) + i;
    hashStr += alphabet.charAt(charCode % alphabet.length);
  }
  return hashStr;
}

// Register Wallet Simulation
btnRegister.addEventListener("click", () => {
  const username = walletUsernameInput.value.trim() || "user_" + Math.random().toString(36).substring(7);
  
  addLog(`[passkey] Launching WebAuthn Credential Creation for user: ${username}...`, "info");
  addLog("Waiting for local passkey signature response...", "info");

  // Simulate WebAuthn Registration delay
  btnRegister.disabled = true;
  setTimeout(() => {
    const mockAddress = generateMockSorobanAddress(username);
    const mockPubKeyHex = Array.from({length: 32}, () => Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join('');
    
    localStorage.setItem("veil_address", mockAddress);
    localStorage.setItem("veil_username", username);
    localStorage.setItem("veil_pubkey_hex", mockPubKeyHex);
    localStorage.setItem("veil_deployed", "false");

    addLog(`✅ Passkey Registered! Raw Public Key: ${mockPubKeyHex.slice(0, 16)}...`, "success");
    addLog(`Computed deterministic contract address: ${mockAddress}`, "success");
    
    initWalletUI();
    btnRegister.disabled = false;
  }, 1000);
});

// Login Simulation
btnLogin.addEventListener("click", () => {
  addLog(`[login] Restoring session credentials from local storage...`, "info");
  
  const mockAddress = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQAHHAGK6W2R";
  const username = "saved_user";
  
  localStorage.setItem("veil_address", mockAddress);
  localStorage.setItem("veil_username", username);
  localStorage.setItem("veil_deployed", "true");
  
  addLog(`✅ Restored Veil account: ${shortenAddress(mockAddress)} (${username})`, "success");
  initWalletUI();
});

// Deploy Contract Simulation
btnDeploy.addEventListener("click", () => {
  const address = localStorage.getItem("veil_address");
  if (!address) return;

  addLog(`[soroban] Initiating on-chain deployment transaction for contract: ${shortenAddress(address)}...`, "info");
  addLog("Requesting Friendbot XLM testnet funding for fee payer...", "info");
  
  btnDeploy.disabled = true;
  btnDeploy.textContent = "Deploying...";

  // Simulate stellar-sdk flow: load account, fund account, construct transaction, submit
  setTimeout(() => {
    addLog("Friendbot funding SUCCESS. Constructing transaction...", "info");
    
    setTimeout(() => {
      const mockTxHash = Array.from({length: 32}, () => Math.floor(Math.random()*16).toString(16)).join('');
      localStorage.setItem("veil_deployed", "true");
      
      addLog(`✅ Soroban contract successfully deployed!`, "success");
      addLog(`Tx Hash: ${mockTxHash}`, "success");
      
      initWalletUI();
      btnDeploy.textContent = "Deploy Contract";

      // Display a toast on-page to celebrate!
      if (isConnectedToTab) {
        chrome.runtime.sendMessage({
          type: "SEND_TO_PAGE",
          tabId: currentTabId,
          payload: {
            type: "DISPLAY_TOAST",
            text: "Veil wallet contract deployed on-chain!",
            toastType: "success"
          }
        });
      }
    }, 1200);
  }, 1000);
});

// Sign Payload Simulation
btnSignPayload.addEventListener("click", () => {
  const address = localStorage.getItem("veil_address");
  if (!address) return;

  const randomPayload = new Uint8Array(32);
  crypto.getRandomValues(randomPayload);
  const payloadHex = Array.from(randomPayload).map(b => b.toString(16).padStart(2, '0')).join('');
  
  addLog(`[sign] Prompting passkey signature request for challenge payload: ${payloadHex.slice(0, 16)}...`, "info");

  // Send message to the tab's content script to show visual confirmation
  if (isConnectedToTab) {
    chrome.runtime.sendMessage({
      type: "SEND_TO_PAGE",
      tabId: currentTabId,
      payload: {
        type: "MOCK_TRANSACTION_SIGN",
        txHash: payloadHex
      }
    }, (response) => {
      if (response && response.success && response.response) {
        addLog(`✅ Signature created successfully via active tab handshake!`, "success");
        addLog(`Raw Signature: ${response.response.signature.slice(0, 24)}...`, "success");
      } else {
        // Run signature locally inside the extension
        addLog("Generating local WebAuthn mock signature...", "info");
        setTimeout(() => {
          const mockSig = "mock_sig_local_" + Math.random().toString(36).substring(2);
          addLog(`✅ Local signature completed! Sig: ${mockSig.slice(0, 16)}...`, "success");
        }, 1000);
      }
    });
  } else {
    // Run signature locally inside the extension
    addLog("Generating local WebAuthn mock signature...", "info");
    setTimeout(() => {
      const mockSig = "mock_sig_local_" + Math.random().toString(36).substring(2);
      addLog(`✅ Local signature completed! Sig: ${mockSig.slice(0, 16)}...`, "success");
    }, 1000);
  }
});

// Reset Wallet State (Disconnect)
btnReset.addEventListener("click", () => {
  localStorage.removeItem("veil_address");
  localStorage.removeItem("veil_username");
  localStorage.removeItem("veil_pubkey_hex");
  localStorage.removeItem("veil_deployed");
  
  addLog("Disconnected wallet and cleared local credentials.", "warning");
  initWalletUI();
});

// Copy address button
btnCopyAddress.addEventListener("click", () => {
  const fullAddress = walletAddressStr.dataset.fullAddress;
  if (!fullAddress) return;
  
  navigator.clipboard.writeText(fullAddress).then(() => {
    addLog("Address copied to clipboard!", "success");
    
    // Animate copy feedback
    const originalIcon = btnCopyAddress.innerHTML;
    btnCopyAddress.innerHTML = `<svg class="icon-sm" style="color: var(--success);" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
    </svg>`;
    setTimeout(() => {
      btnCopyAddress.innerHTML = originalIcon;
    }, 1500);
  });
});


// ── 4. Initializer Run ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchInitialActiveTab();
  initWalletUI();
});
