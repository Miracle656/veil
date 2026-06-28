<template>
  <NuxtRouteAnnouncer />
  <NuxtPage />
</template>

<style>
:root {
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: #0a0a0f;
  color: #e5e7eb;
}
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
.card {
  width: 100%;
  max-width: 24rem;
  border: 1px solid #1f2937;
  background: #111827;
  border-radius: 1rem;
  padding: 1.5rem;
}
.stack > * + * {
  margin-top: 1rem;
}
h1 {
  font-size: 1.75rem;
  margin: 0;
}
.muted {
  color: #9ca3af;
  font-size: 0.85rem;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
input {
  width: 100%;
  border: 1px solid #374151;
  background: #1f2937;
  color: inherit;
  border-radius: 0.5rem;
  padding: 0.55rem 0.75rem;
  font-size: 0.9rem;
}
button {
  width: 100%;
  border-radius: 0.5rem;
  padding: 0.6rem 1rem;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #374151;
  background: #4f46e5;
  color: white;
  transition: opacity 0.15s;
}
button.secondary {
  background: transparent;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
a {
  color: #818cf8;
}
.alert {
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
}
.alert.error {
  border: 1px solid #7f1d1d;
  background: #450a0a;
  color: #fca5a5;
}
.alert.success {
  border: 1px solid #166534;
  background: #052e16;
  color: #86efac;
}
</style>
