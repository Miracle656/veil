# Veil Chrome Extension Example (Manifest V3)

This directory contains a complete, self-contained Chrome Manifest V3 Extension that showcases a **cross-tab side panel UI** for the Veil Wallet. 

Even though Veil is primarily extension-less, some users prefer the convenience of an extension UI that follows them across browser tabs. This example demonstrates how to integrate the side panel API and implement robust message-passing between the **Side Panel**, the **Background Service Worker**, and the **Content Scripts** running on active dApp pages.

---

## Features

1. **Manifest V3 Compliant**: Adheres to the latest extension standards.
2. **Chrome Side Panel Integration**: Embeds the Veil wallet directly into the browser's native side panel.
3. **Cross-Tab Synchronization**: Automatically queries browser tabs on switch or navigation to fetch the current active tab context (Title, URL, Domain) and coordinates permissions.
4. **Rich Message Passing**:
   - **Side Panel ➔ Tab**: Sends custom messages to display custom toasts/notifications on the page or triggers interactive scripts (like highlighting actionable buttons on the page).
   - **Tab ➔ Side Panel**: Demonstrates how standard web pages can issue calls via `window.postMessage` to prompt the Veil extension for transaction signatures.
5. **Wallet State & Action Simulator**: Simulates key cryptographic operations:
   - **Register**: Generates passkeys and computes deterministic contract addresses based on standard Soroban contract generation logic.
   - **Deploy**: Simulates Soroban smart contract deployments with Friendbot testnet XLM funding.
   - **Sign Payload**: Simulates on-chain transaction signing with passkey WebAuthn signatures.
6. **Built-in Console Log**: An integrated developer console at the bottom of the side panel that displays detailed runtime events, allowing you to observe message passing and system logs in real time.

---

## File Structure

```text
examples/chrome-extension/
├── manifest.json      # Extension configuration and permission declarations
├── background.js     # Background Service Worker for connection tracking & message routing
├── content.js        # Content script injected into active tabs for page-level interactions
├── sidepanel.html    # The gorgeous HTML layout for the wallet dashboard
├── sidepanel.css     # Stunning, responsive, dark-theme styles & CSS animations
├── sidepanel.js      # Main controller managing wallet state and browser tab handshakes
└── README.md         # This documentation
```

---

## Quick Start: Loading the Extension

To run and test this extension locally, follow these simple steps:

1. Open your Google Chrome browser.
2. Navigate to **`chrome://extensions/`** by typing it in the URL bar.
3. In the top-right corner, toggle the **Developer mode** switch to **ON**.
4. In the top-left corner, click the **Load unpacked** button.
5. Select the `examples/chrome-extension` folder inside your cloned `veil` repository.
6. The **Veil Wallet Extension** will now be loaded and active!

---

## How to Test and Interact

### 1. Opening the Side Panel
- Click the Extensions puzzle piece icon in the Chrome toolbar.
- Pin the **Veil Wallet Extension** to the toolbar.
- Click the **Veil icon** in the toolbar. The native Chrome Side Panel will slide open displaying the Veil Wallet dashboard!

### 2. Tab Synchronization & Site Handshake
- Navigate to any standard web page (e.g., `https://google.com` or `https://stellar.org`).
- Notice that the **Active Tab Context** card in the side panel instantly updates to show the tab's current title and domain.
- Click **Connect to Site** to establish a session. You will see a success toast appear on the bottom-right of the active webpage, and the connection badge in the side panel will change to green **"Connected"**.

### 3. Page Interaction (Message-Passing)
Once connected, test the different message-passing commands:
- **Ping Page**: Click the button to send a message. The bottom logs will print the exact return payload from the content script (`[pong] Received response from tab...`).
- **Send Toast**: Type a custom message in the input and click **Send Toast**. The message will fly in as an elegant on-page toast on the active tab's web page.
- **Highlight Elements**: Click the button to trigger a script that briefly highlights all buttons/links on the active webpage with a blue outline, showing page-level DOM control.

### 4. Wallet Operations
Interact with the mock WebAuthn-Soroban wallet:
- **Register**: Enter a username and click **Register with Passkey**. This simulates credential creation and displays your deterministic contract address.
- **Deploy**: Click **Deploy Contract**. The console logs will track the simulation of testnet Friendbot funding and contract execution.
- **Sign Payload**: Click **Sign Payload** to simulate a WebAuthn transaction signature, including the page toast verification.
