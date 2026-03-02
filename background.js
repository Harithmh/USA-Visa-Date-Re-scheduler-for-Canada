// Base URLs and storage/alarm keys used by the extension background worker.
const AIS_HOST = 'https://ais.usvisa-info.com/';
const SIGN_IN_URL = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';
const ALARM_NAME = 'aisAutoRetry';
const LAST_URL_KEY = 'lastUrlByTab';

// In-memory cache of the last known valid AIS URL for each tab.
let lastUrlByTab = {};

// True only for AIS website URLs.
function isAisUrl(url) {
  return typeof url === 'string' && url.startsWith(AIS_HOST);
}

// True when the tab is showing Chrome's network error page.
function isChromeErrorUrl(url) {
  return typeof url === 'string' && url.startsWith('chrome-error://');
}

// Save the last valid AIS URL for a tab so we can recover from tab errors.
function recordLastUrl(tabId, url) {
  if (!isAisUrl(url)) return;
  lastUrlByTab[tabId] = url;
  chrome.storage.session.set({ [LAST_URL_KEY]: lastUrlByTab });
}

// Restore URL cache from session storage after extension restart.
function loadLastUrlCache() {
  chrome.storage.session.get([LAST_URL_KEY], (data) => {
    if (data && data[LAST_URL_KEY]) lastUrlByTab = data[LAST_URL_KEY];
  });
}

// Keep a recurring alarm that checks for broken/error tabs.
function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
}

// On install, initialize cache and alarm.
chrome.runtime.onInstalled.addListener(() => {
  loadLastUrlCache();
  ensureAlarm();
});

// On browser startup, reinitialize cache and alarm.
chrome.runtime.onStartup.addListener(() => {
  loadLastUrlCache();
  ensureAlarm();
});

// Track each tab URL update so we always have a recoverable target.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) recordLastUrl(tabId, changeInfo.url);
  if (tab && tab.url) recordLastUrl(tabId, tab.url);
});

// Alarm handler: if a tab is on chrome-error://, reopen its last known AIS page.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab || !tab.id || !tab.url) continue;
      if (!isChromeErrorUrl(tab.url)) continue;

      const lastUrl = lastUrlByTab[tab.id];
      if (!lastUrl) continue;
      if (!isAisUrl(lastUrl)) continue;

      // Signal relogin after recovery and retry the last known page.
      chrome.storage.local.set({ pendingRelogin: true }, () => {
        chrome.tabs.update(tab.id, { url: lastUrl || SIGN_IN_URL });
      });
    }
  });
});
