// Content script for AIS pages:
// - Recovers from error/maintenance pages
// - Handles auto-login
// - Polls appointment APIs for matching dates
// - Autofills date/time and optionally submits booking
// - Adds optional on-page debug log overlay

// Fallback: If booking fails (date full or invalid), resume checking
function detectBookingFailureAndResume() {
    const errorTexts = [
        'please choose a working day',
        'no longer available',
        'fully booked',
        'not available',
        'please select a valid date',
        'please select a working day',
        'please choose another date',
        'please select a date',
        'no time slots available',
        'no appointments available'
    ];
    const bodyText = document.body && document.body.innerText ? document.body.innerText.toLowerCase() : '';
    for (const msg of errorTexts) {
        if (bodyText.includes(msg)) {
            const now = Date.now();
            if (now - lastFailureHandledAt < 2000) return;
            lastFailureHandledAt = now;
            console.log('Booking failed or invalid date detected, trying next date...');
            setTimeout(() => { tryNextDateFromQueue(); }, 600 + Math.random() * 800);
            break;
        }
    }
}

function startBookingFailureWatcher() {
    try {
        if (!window.location.href.includes('/appointment')) return;
        const observer = new MutationObserver(() => {
            detectBookingFailureAndResume();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        // Stop watching after a short window to avoid long-lived observers
        setTimeout(() => { try { observer.disconnect(); } catch (e) {} }, 15000);
    } catch (e) {}
}

// Watch for booking failure after page loads or navigation
window.addEventListener('DOMContentLoaded', detectBookingFailureAndResume);
window.addEventListener('load', detectBookingFailureAndResume);
window.addEventListener('DOMContentLoaded', startBookingFailureWatcher);
window.addEventListener('load', startBookingFailureWatcher);
initOverlayLogging();
const SIGN_IN_URL = 'https://ais.usvisa-info.com/en-ca/niv/users/sign_in';

// Auto-recover from 404, maintenance, or network error page
if (document.body && document.body.innerText && (
    document.body.innerText.includes('404: Page Not Found') ||
    document.body.innerText.toLowerCase().includes('doing maintenance') ||
    document.body.innerText.toLowerCase().includes('planned maintenance') ||
    document.body.innerText.toLowerCase().includes('website is down') ||
    document.body.innerText.toLowerCase().includes('this site can\'t be reached') ||
    document.body.innerText.toLowerCase().includes('err_connection_reset') ||
    document.body.innerText.toLowerCase().includes('err_connection_timed_out')
)) {
    const bodyLower = document.body.innerText.toLowerCase();
    const isNetworkError = bodyLower.includes('this site can\'t be reached') ||
        bodyLower.includes('err_connection_reset') ||
        bodyLower.includes('err_connection_timed_out');
    const isMaintenance = bodyLower.includes('maintenance') || bodyLower.includes('website is down') || bodyLower.includes('404: page not found');

    let minDelay = isMaintenance ? 60000 : 25000;
    let maxDelay = isMaintenance ? 180000 : 65000;
    if (window.location.href.includes('/en-ca/users/sign_in')) {
        minDelay = 3000;
        maxDelay = 8000;
    }
    const delayMs = Math.round(minDelay + Math.random() * (maxDelay - minDelay) + Math.random() * 5000);

    try {
        chrome.storage.local.get(['maintenanceNextAttemptAt'], (data) => {
            const now = Date.now();
            const nextAt = data && data.maintenanceNextAttemptAt ? Number(data.maintenanceNextAttemptAt) : 0;
            if (now < nextAt) return;

            chrome.storage.local.set({ maintenanceNextAttemptAt: now + delayMs }, () => {});
            console.warn(`Recovery backoff: waiting ${Math.round(delayMs / 1000)}s before retrying...`);

            setTimeout(() => {
                try { chrome.storage.local.set({ pendingRelogin: true }, () => {}); } catch (e) {}
                if (isNetworkError) window.location.reload();
                else window.location.href = SIGN_IN_URL;
            }, delayMs);
        });
    } catch (e) {}
}

// 1. AUTO-LOGIN
if (window.location.href.includes('/users/sign_in')) {
    chrome.storage.local.get(['toggleActive', 'loginEmail', 'loginPass'], (data) => {
        if (!data.toggleActive || !data.loginEmail) return;
        setTimeout(() => {
            const emailField = document.querySelector('#user_email');
            const passField = document.querySelector('#user_password');
            const policyCheck = document.querySelector('#policy_confirmed');
            const loginBtn = document.querySelector('input[name="commit"]');

            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const typeLikeHuman = async (el, text) => {
                if (!el) return;
                el.focus();
                el.value = '';
                for (const ch of String(text)) {
                    el.value += ch;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    await sleep(40 + Math.random() * 80);
                    if (Math.random() < 0.15) await sleep(100 + Math.random() * 200);
                }
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };

            (async () => {
                if (emailField && passField) {
                    await sleep(300 + Math.random() * 400);
                    // Random scroll before filling form
                    if (Math.random() < 0.5) performRandomScroll();
                    await sleep(200 + Math.random() * 300);
                    await typeLikeHuman(emailField, data.loginEmail);
                    await sleep(250 + Math.random() * 350);
                    // Occasional mouse movement
                    if (Math.random() < 0.4) simulateMouseMovement();
                    await sleep(150 + Math.random() * 200);
                    await typeLikeHuman(passField, data.loginPass);
                    await sleep(400 + Math.random() * 500);
                    if (policyCheck && !policyCheck.checked) policyCheck.click();
                    await sleep(350 + Math.random() * 450);
                    if (loginBtn) loginBtn.click();
                }
            })();
        }, 500);
    });
}

// 2. APPOINTMENT CHECKER (API Logic)
const SCHEDULE_ID = window.location.href.split('/schedule/')[1]?.split('/')[0];

// Complete Map of Canadian Facility IDs
const FACILITY_MAP = {
    "Calgary": "89", "Halifax": "90", "Montreal": "91",
    "Ottawa": "92", "Quebec City": "93", "Toronto": "94", "Vancouver": "95"
};

let pendingDateQueue = null;
let pendingFacilityId = null;
let pendingCity = null;
let pendingAutobookEnabled = false;
let dateSelectionInProgress = false;
let lastFailureHandledAt = 0;
let lastSelectedDate = null;
let lastSelectedFacilityId = null;
let lastTimeSelectionKey = null;
let lastTimeSelectionAt = 0;
let checkLoopInProgress = false;
let matchInProgress = false;
let checkLoopTimer = null;
let lastCsrfMissingAt = 0;

// Overlay/debug state (used when debugOverlay is enabled in popup settings).
let overlayEnabled = false;
let overlayEl = null;
let overlayListEl = null;
let overlayBuffer = [];
let consoleWrapped = false;
let originalConsole = null;

const OVERLAY_MAX_ENTRIES = 80;

// Create overlay root container and static UI shell.
function ensureOverlayRoot() {
    if (overlayEl || !document.body) return;

    overlayEl = document.createElement('div');
    overlayEl.setAttribute('id', 'visa-runner-overlay');
    overlayEl.style.cssText = [
        'position:fixed',
        'right:14px',
        'bottom:14px',
        'width:360px',
        'max-width:92vw',
        'height:240px',
        'background:rgba(20,22,28,0.92)',
        'color:#e6e6e6',
        'font:12px/1.4 "Segoe UI", Tahoma, Arial, sans-serif',
        'border:1px solid rgba(255,255,255,0.08)',
        'border-radius:8px',
        'box-shadow:0 10px 24px rgba(0,0,0,0.28)',
        'z-index:2147483647',
        'display:flex',
        'flex-direction:column'
    ].join(';');

    const header = document.createElement('div');
    header.style.cssText = [
        'display:flex',
        'align-items:center',
        'justify-content:space-between',
        'padding:8px 10px',
        'border-bottom:1px solid rgba(255,255,255,0.08)',
        'background:linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0))'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Visa runner logs';
    title.style.cssText = 'font-weight:600;letter-spacing:0.2px;';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'Hide';
    closeBtn.style.cssText = [
        'background:transparent',
        'color:#c8c8c8',
        'border:1px solid rgba(255,255,255,0.15)',
        'border-radius:6px',
        'padding:2px 8px',
        'cursor:pointer'
    ].join(';');
    closeBtn.addEventListener('click', () => {
        try { chrome.storage.local.set({ debugOverlay: false }, () => {}); } catch (e) {}
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    overlayListEl = document.createElement('div');
    overlayListEl.style.cssText = [
        'flex:1',
        'overflow:auto',
        'padding:8px 10px',
        'white-space:pre-wrap',
        'font-family:Consolas, "Courier New", monospace'
    ].join(';');

    overlayEl.appendChild(header);
    overlayEl.appendChild(overlayListEl);
    document.body.appendChild(overlayEl);
}

function renderOverlayBuffer() {
    if (!overlayListEl) return;
    overlayListEl.innerHTML = '';
    for (const entry of overlayBuffer) {
        const row = document.createElement('div');
        const color = entry.level === 'error' ? '#ff6b6b' : entry.level === 'warn' ? '#ffd166' : '#9be7ff';
        row.style.color = color;
        row.textContent = entry.text;
        overlayListEl.appendChild(row);
    }
    overlayListEl.scrollTop = overlayListEl.scrollHeight;
}

// Push a single log line into the overlay buffer.
function appendOverlayEntry(level, args) {
    if (!overlayEnabled) return;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const parts = Array.from(args || []).map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
    });
    let text = `[${time}] ${parts.join(' ')}`;
    if (text.length > 800) text = text.slice(0, 800) + '...';
    overlayBuffer.push({ level, text });
    if (overlayBuffer.length > OVERLAY_MAX_ENTRIES) {
        overlayBuffer = overlayBuffer.slice(-OVERLAY_MAX_ENTRIES);
    }
    renderOverlayBuffer();
}

// Monkey-patch console so logs also appear in the overlay.
function wrapConsoleForOverlay() {
    if (consoleWrapped) return;
    originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error
    };
    console.log = (...args) => {
        originalConsole.log.apply(console, args);
        appendOverlayEntry('log', args);
    };
    console.warn = (...args) => {
        originalConsole.warn.apply(console, args);
        appendOverlayEntry('warn', args);
    };
    console.error = (...args) => {
        originalConsole.error.apply(console, args);
        appendOverlayEntry('error', args);
    };
    consoleWrapped = true;
}

// Restore original console methods when overlay is disabled.
function unwrapConsoleForOverlay() {
    if (!consoleWrapped || !originalConsole) return;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    originalConsole = null;
    consoleWrapped = false;
}

// Toggle overlay lifecycle (create/destroy + wrap/unwrap console).
function setOverlayEnabled(enabled) {
    overlayEnabled = !!enabled;
    if (!overlayEnabled) {
        unwrapConsoleForOverlay();
        if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
        overlayEl = null;
        overlayListEl = null;
        overlayBuffer = [];
        return;
    }

    if (document.body) {
        ensureOverlayRoot();
        wrapConsoleForOverlay();
        renderOverlayBuffer();
    } else {
        window.addEventListener('DOMContentLoaded', () => {
            ensureOverlayRoot();
            wrapConsoleForOverlay();
            renderOverlayBuffer();
        }, { once: true });
    }
}

function initOverlayLogging() {
    try {
        chrome.storage.local.get(['debugOverlay'], (data) => {
            setOverlayEnabled(!!data.debugOverlay);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.debugOverlay) return;
            setOverlayEnabled(!!changes.debugOverlay.newValue);
        });
    } catch (e) {}
}

const LOG_VERBOSE = false;

// Verbose logging helper to avoid noisy logs in normal mode.
function logVerbose(...args) {
    if (LOG_VERBOSE) console.log(...args);
}

// Human-like behavior: Random scrolling
function performRandomScroll() {
    if (!document.body) return;
    try {
        const currentScroll = window.scrollY || document.documentElement.scrollTop;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        
        // 60% chance to scroll down, 30% up, 10% stay
        const direction = Math.random();
        let targetScroll = currentScroll;
        
        if (direction < 0.6 && currentScroll < maxScroll) {
            // Scroll down 100-400px
            targetScroll = Math.min(currentScroll + 100 + Math.random() * 300, maxScroll);
        } else if (direction < 0.9 && currentScroll > 0) {
            // Scroll up 50-300px
            targetScroll = Math.max(currentScroll - 50 - Math.random() * 250, 0);
        }
        
        // Smooth scroll with random behavior option
        const smooth = Math.random() < 0.7; // 70% smooth, 30% instant
        window.scrollTo({
            top: targetScroll,
            behavior: smooth ? 'smooth' : 'auto'
        });
        
        logVerbose(`Random scroll: ${currentScroll} → ${targetScroll} (${smooth ? 'smooth' : 'instant'})`);
    } catch (e) {
        // Fallback for older browsers
        try {
            const delta = (Math.random() - 0.5) * 300;
            window.scrollBy(0, delta);
        } catch (e2) {}
    }
}

// Human-like behavior: Random mouse movements
function simulateMouseMovement() {
    if (!document.body) return;
    try {
        const x = Math.floor(Math.random() * window.innerWidth);
        const y = Math.floor(Math.random() * window.innerHeight);
        
        const moveEvent = new MouseEvent('mousemove', {
            view: window,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            screenX: x + window.screenX,
            screenY: y + window.screenY
        });
        
        document.dispatchEvent(moveEvent);
        logVerbose(`Mouse movement simulated: (${x}, ${y})`);
    } catch (e) {}
}

// Human-like behavior: Random small movements in a pattern
async function performNaturalMousePattern() {
    const movements = 3 + Math.floor(Math.random() * 4); // 3-6 movements
    const baseX = Math.floor(Math.random() * window.innerWidth);
    const baseY = Math.floor(Math.random() * window.innerHeight);
    
    for (let i = 0; i < movements; i++) {
        const offsetX = (Math.random() - 0.5) * 150;
        const offsetY = (Math.random() - 0.5) * 150;
        const x = Math.max(0, Math.min(window.innerWidth, baseX + offsetX));
        const y = Math.max(0, Math.min(window.innerHeight, baseY + offsetY));
        
        try {
            const moveEvent = new MouseEvent('mousemove', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            });
            document.dispatchEvent(moveEvent);
        } catch (e) {}
        
        await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
    }
    logVerbose(`Natural mouse pattern completed: ${movements} movements`);
}

// Randomly trigger human-like behaviors
async function performRandomHumanBehavior() {
    const actions = [];
    
    // 40% chance to scroll
    if (Math.random() < 0.4) {
        actions.push(async () => {
            performRandomScroll();
            await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
        });
    }
    
    // 30% chance for mouse movements
    if (Math.random() < 0.3) {
        actions.push(async () => {
            await performNaturalMousePattern();
        });
    }
    
    // 20% chance for simple mouse movement
    if (Math.random() < 0.2 && actions.length === 0) {
        actions.push(async () => {
            simulateMouseMovement();
            await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        });
    }
    
    // Execute selected actions
    for (const action of actions) {
        await action();
    }
}

// Start background human behavior simulation
let humanBehaviorInterval = null;
function startHumanBehaviorSimulation() {
    if (humanBehaviorInterval) return;
    
    const scheduleNext = () => {
        const delay = 8000 + Math.random() * 20000; // Every 8-28 seconds
        humanBehaviorInterval = setTimeout(async () => {
            await performRandomHumanBehavior();
            scheduleNext();
        }, delay);
    };
    
    scheduleNext();
    logVerbose('Human behavior simulation started');
}

function stopHumanBehaviorSimulation() {
    if (humanBehaviorInterval) {
        clearTimeout(humanBehaviorInterval);
        humanBehaviorInterval = null;
        logVerbose('Human behavior simulation stopped');
    }
}


// Reset any in-progress date queue and matching state.
function clearPendingQueue() {
    pendingDateQueue = null;
    pendingFacilityId = null;
    pendingCity = null;
    pendingAutobookEnabled = false;
    matchInProgress = false;
    dateSelectionInProgress = false;
    try {
        chrome.storage.local.remove(['pendingDates', 'pendingFacilityId', 'pendingCity', 'pendingAutobookEnabled']);
    } catch (e) {}
}

// Cancel and quickly restart checking loop (used when settings change).
function restartCheckLoopSoon() {
    if (checkLoopTimer) {
        clearTimeout(checkLoopTimer);
        checkLoopTimer = null;
    }
    scheduleNextCheck(300);
}

// Track repeated failures to trigger relogin/backoff behavior.
function incrementConsecFailures() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(['consecFailures'], (d) => {
                const n = (d && d.consecFailures ? d.consecFailures : 0) + 1;
                chrome.storage.local.set({ consecFailures: n }, () => resolve(n));
            });
        } catch (e) {
            resolve(0);
        }
    });
}

// Mark relogin needed and redirect to sign-in page.
async function requestRelogin(reason, extra) {
    try {
        chrome.storage.local.set({ pendingRelogin: true, consecFailures: 0 }, () => {});
    } catch (e) {}
    window.location.href = SIGN_IN_URL;
    return true;
}
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;

        if (changes.toggleActive && changes.toggleActive.newValue === false) {
            if (checkLoopTimer) {
                clearTimeout(checkLoopTimer);
                checkLoopTimer = null;
            }
            return;
        }

        const affectsQueue = changes.startDate || changes.endDate || changes.preferredCities || changes.toggleAutobook;
        const affectsLoop = affectsQueue || changes.minDelay || changes.maxDelay || changes.frequencyUnit || changes.toggleActive;

        if (affectsQueue) clearPendingQueue();
        if (affectsLoop) restartCheckLoopSoon();
    });
} catch (e) {}

function isBusinessDay(dObj) {
    const day = dObj.getDay();
    return day >= 1 && day <= 5;
}

// Parse YYYY-MM-DD reliably in local timezone.
function parseIsoDateLocal(dateStr) {
    const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(dateStr));
    if (!m) return new Date(dateStr);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Format Date object as YYYY-MM-DD.
function toYmd(dObj) {
    const y = dObj.getFullYear();
    const m = String(dObj.getMonth() + 1).padStart(2, '0');
    const d = String(dObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Schedule next polling attempt with jitter to reduce fixed patterns.
function scheduleNextCheck(delayMs) {
    if (checkLoopTimer) {
        clearTimeout(checkLoopTimer);
        checkLoopTimer = null;
    }
    const jitter = Math.random() * Math.min(delayMs * 0.3, 5000);
    checkLoopTimer = setTimeout(checkLoop, delayMs + jitter);
}

// Fetch wrapper with optional timeout support.
async function fetchWithTimeout(url, options, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) {
        return fetch(url, options);
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(t);
    }
}

// Fetch wrapper with retry + exponential backoff.
async function fetchWithRetry(url, options, attempts, timeoutMs) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetchWithTimeout(url, options, timeoutMs);
            return res;
        } catch (e) {
            lastErr = e;
            const backoff = Math.min(500 * Math.pow(2, i), 5000) + Math.random() * 1000;
            await new Promise(r => setTimeout(r, backoff));
        }
    }
    throw lastErr;
}

// Cache candidate dates/facility and optionally persist to storage.
function setPendingDates(city, dates, facilityId, autobookEnabled, persist) {
    const shouldPersist = persist !== false;
    pendingCity = city;
    pendingFacilityId = facilityId;
    pendingAutobookEnabled = !!autobookEnabled;
    pendingDateQueue = Array.isArray(dates) ? dates.slice() : [];
    if (shouldPersist) {
        try {
            chrome.storage.local.set({
                pendingDates: pendingDateQueue,
                pendingFacilityId: pendingFacilityId,
                pendingCity: pendingCity,
                pendingAutobookEnabled: pendingAutobookEnabled
            });
        } catch (e) {}
    }
}

// Try the next candidate date from queue until success or queue exhaustion.
function tryNextDateFromQueue() {
    if (dateSelectionInProgress) return;
    if (!pendingDateQueue || pendingDateQueue.length === 0) {
        console.log('No more candidate dates. Resuming check loop...');
        try {
            chrome.storage.local.remove(['pendingDates', 'pendingFacilityId', 'pendingCity', 'pendingAutobookEnabled']);
        } catch (e) {}
        matchInProgress = false;
        scheduleNextCheck(400);
        return;
    }

    if (!window.location.href.includes('/appointment')) {
        window.location.href = `${window.location.origin}/en-ca/niv/schedule/${SCHEDULE_ID}/appointment`;
        return;
    }

    const nextDate = pendingDateQueue.shift();
    dateSelectionInProgress = true;
    applyDateSelection(nextDate, pendingFacilityId, pendingAutobookEnabled).then((ok) => {
        dateSelectionInProgress = false;
        if (!ok) {
            setTimeout(() => { tryNextDateFromQueue(); }, 200);
        }
    });
}

// Main polling loop: checks selected cities, filters dates, and handles matches.
async function checkLoop() {
    if (checkLoopInProgress || matchInProgress) return;
    checkLoopInProgress = true;
    chrome.storage.local.get(null, async (config) => {
        try {
            // Only run if active, schedule ID is found, and cities are selected
            if (!config.toggleActive || !SCHEDULE_ID || !config.preferredCities) return;

            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            if (!csrfToken) {
                const now = Date.now();
                if (now - lastCsrfMissingAt > 3000) {
                    lastCsrfMissingAt = now;
                    console.warn('CSRF token missing. Redirecting to sign-in to refresh session.');
                    await requestRelogin('csrf_missing');
                }
                return;
            }

            const userStart = config.startDate ? new Date(config.startDate) : new Date();
            const userEnd = config.endDate ? new Date(config.endDate) : new Date("2099-12-31");
            const startYmd = toYmd(userStart);
            const endYmd = toYmd(userEnd);

            for (let city of config.preferredCities) {
                const facilityId = FACILITY_MAP[city];
                if (!facilityId) continue;

            try {
                logVerbose(`Checking API for ${city}...`);
                const url = `https://ais.usvisa-info.com/en-ca/niv/schedule/${SCHEDULE_ID}/appointment/days/${facilityId}.json?appointments[expedite]=false`;
                
                // Random delay with occasional human behavior before request
                await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
                if (Math.random() < 0.3) {
                    simulateMouseMovement();
                    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
                }
                
                const res = await fetchWithRetry(url, {
                    method: 'GET',
                    headers: { 
                        "X-Requested-With": "XMLHttpRequest", 
                        "X-CSRF-Token": csrfToken,
                        "Accept": "application/json, text/javascript, */*; q=0.01",
                        "Cache-Control": "no-cache"
                    },
                    credentials: 'same-origin'
                }, 1, 15000);

                logVerbose(`Fetch ${url} -> status ${res.status}`);

                // Handle 401 Unauthorized - session expired
                if (res.status === 401) {
                    console.log('❌ 401 Unauthorized detected - session expired. Redirecting to login...');
                    await requestRelogin('unauthorized_401', { status: res.status });
                    return;
                }

                // When server returns non-OK, log details and apply a simple backoff
                if (!res.ok) {
                    const ct = res.headers.get('content-type') || '';
                    let preview = '';
                    try {
                        preview = await res.text();
                        if (preview && preview.length > 500) preview = preview.slice(0, 500) + '...';
                    } catch (e) { preview = '[body read failed]'; }
                    console.warn(`Request returned ${res.status} for ${city} (content-type: ${ct}). Preview:`, preview);

                    // increment consecutive failure counter to slow future checks
                    const failCount = await incrementConsecFailures();
                    if (failCount >= 10) {
                        console.warn('Too many failed requests. Attempting relogin...');
                        await requestRelogin('consec_failures', { status: res.status, failures: failCount });
                        return;
                    }

                    // If it's a 404 or 429, wait a bit longer before continuing to reduce likely rate-limiting
                    if (res.status === 404 || res.status === 429) {
                        const longBackoff = 8000 + Math.random() * 12000 + (failCount * 2000);
                        console.log(`⏳ Waiting ${Math.round(longBackoff/1000)}s before retry due to ${res.status}...`);
                        await new Promise(r => setTimeout(r, longBackoff));
                    }
                    continue;
                }

                // Reset consecutive-failure counter on success
                try { chrome.storage.local.set({ consecFailures: 0 }); } catch (e) {}

                const dates = await res.json();
                if (!Array.isArray(dates) || dates.length === 0) {
                    console.log(`First available for ${city}: none`);
                    continue;
                }

                const allDates = dates.map(d => d.date).filter(Boolean);
                const firstAny = allDates.length > 0 ? String(allDates[0]).slice(0, 10) : 'none';

                const candidates = allDates.filter(dateStr => {
                    const dateOnly = String(dateStr).slice(0, 10);
                    if (dateOnly < startYmd || dateOnly > endYmd) return false;
                    const dObj = parseIsoDateLocal(dateOnly);
                    return isBusinessDay(dObj);
                });

                const firstInRange = candidates[0] ? String(candidates[0]).slice(0, 10) : 'none in range';
                console.log(`First available for ${city}: ${firstAny} | in range: ${firstInRange}`);

                if (candidates.length > 0) {
                    logVerbose(`Match found in ${city}: ${candidates[0]}`);
                    handleMatchFound(city, candidates, facilityId, !!config.toggleAutobook);
                    return; // Stop the loop on a successful match
                }
            } catch (e) { 
                console.error(`Fetch failed for ${city}:`, e);
                const failCount = await incrementConsecFailures();
                const backoffDelay = Math.min(2000 * Math.pow(1.5, failCount), 30000) + Math.random() * 3000;
                console.log(`⏳ Backing off for ${Math.round(backoffDelay/1000)}s after failure #${failCount}...`);
                await new Promise(r => setTimeout(r, backoffDelay));
                if (failCount >= 8) {
                    console.warn('Too many failed fetches. Attempting relogin...');
                    await requestRelogin('consec_fetch_errors', { failures: failCount, message: String(e) });
                    return;
                }
            }
            
            // Random delay between city checks with variance to prevent rate limiting
            await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
        }

        // Calculate next check interval with human-like variance
        const multiplier = config.frequencyUnit === 'minutes' ? 60000 : 1000;
        const minDelay = parseInt(config.minDelay) || 2;
        const maxDelay = parseInt(config.maxDelay) || 4;
        let delay = (Math.random() * (maxDelay - minDelay) + minDelay) * multiplier;
        // Add up to 30% extra random variance
        const variance = delay * 0.3 * Math.random();
        delay = Math.round(delay + variance);

        logVerbose(`No match found. Retrying in ${Math.round(delay / 1000)}s...`);
        console.log(`⏱️ Next check in ${Math.round(delay / 1000)}s`);
        
        // Perform random human behavior before next check
        if (Math.random() < 0.6) {
            await performRandomHumanBehavior();
        }
        
        scheduleNextCheck(delay);
        } finally {
            checkLoopInProgress = false;
        }
    });
}

// 3. HANDLE MATCH & AUTO-FILLING
function handleMatchFound(city, dateOrDates, facilityId, autobookEnabled) {
    const dateList = Array.isArray(dateOrDates) ? dateOrDates : [dateOrDates];
    matchInProgress = true;
    setPendingDates(city, dateList, facilityId, autobookEnabled, true);

    // Navigate to the appointment page if not already there
    if (!window.location.href.includes('/appointment')) {
        window.location.href = `${window.location.origin}/en-ca/niv/schedule/${SCHEDULE_ID}/appointment`;
        return;
    }

    tryNextDateFromQueue();
}

// Apply chosen facility/date, then attempt to select a time (and submit if enabled).
async function applyDateSelection(date, facilityId, autobookEnabled) {
    lastSelectedDate = date;
    lastSelectedFacilityId = facilityId;
    
    // Random human behavior before form interaction
    if (Math.random() < 0.4) {
        performRandomScroll();
        await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
    }
    
    // Fill the facility and date fields
    const facSelect = document.querySelector("#appointments_consulate_appointment_facility_id");
    if (facSelect) {
        facSelect.value = facilityId;
        facSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Short initial pause to allow the facility change handlers to run
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    const dateInput = document.querySelector("#appointments_consulate_appointment_date");
    if (!dateInput) return false;

    dateInput.value = date;
    // Dispatch input/change and focus so the widget notices the programmatic value
    dateInput.dispatchEvent(new Event('input', { bubbles: true }));
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    dateInput.dispatchEvent(new Event('focus', { bubbles: true }));

    // Human-like pause before interacting with calendar
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    
    // Random scroll or mouse movement before interaction
    if (Math.random() < 0.5) {
        performRandomScroll();
        await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
    }
    if (Math.random() < 0.4) {
        simulateMouseMovement();
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }

    // Try to open the calendar widget with natural interaction
    try { dateInput.click(); } catch (e) {}
    await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    try {
        dateInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
        dateInput.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
        dateInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch (e) {}
    await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
    try {
        dateInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        dateInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (e) {}

    const clicked = await clickCalendarDate(date, { fast: true });
    const delay = clicked ? (120 + Math.random() * 180) : (250 + Math.random() * 350);
    await new Promise(r => setTimeout(r, delay));
    const enabledNow = autobookEnabled ? await getAutobookEnabled() : false;
    const timeOk = await attemptTimeSelection(enabledNow, `${facilityId}|${date}`);
    if (timeOk) {
        // Stop further retries after a successful time selection
        pendingDateQueue = null;
        matchInProgress = false;
        try {
            chrome.storage.local.remove(['pendingDates', 'pendingFacilityId', 'pendingCity', 'pendingAutobookEnabled']);
        } catch (e) {}
    }
    return !!clicked && !!timeOk;
}

// Wait for available time slots in UI, with API fallback if list is empty.
function attemptTimeSelection(autobook = false, selectionKey = '') {
    return new Promise((resolve) => {
        const maxMs = 5000;
        const intervalMs = 60;
        const apiFallbackAfterMs = 800;
        let elapsed = 0;
        let apiFallbackTried = false;

        const getScheduleButton = () => {
            return document.querySelector('input[name="commit"], #appointments_submit, button[type="submit"]');
        };

        const isScheduleButtonActive = () => {
            const btn = getScheduleButton();
            if (!btn) return false;
            if (btn.disabled) return false;
            const ariaDisabled = (btn.getAttribute('aria-disabled') || '').toLowerCase();
            if (ariaDisabled === 'true') return false;
            return true;
        };

        const pickValidTimeOption = async () => {
            const timeSelect = document.querySelector("#appointments_consulate_appointment_time, select[name*='time']");
            if (!timeSelect || !timeSelect.options || timeSelect.options.length <= 1) return false;

            const optionIndexes = [];
            for (let i = 1; i < timeSelect.options.length; i++) {
                if (timeSelect.options[i].value && timeSelect.options[i].value.trim() !== '') {
                    optionIndexes.push(i);
                }
            }
            if (optionIndexes.length === 0) return false;

            for (const idx of optionIndexes) {
                timeSelect.selectedIndex = idx;
                timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(r => setTimeout(r, 150 + Math.random() * 150));
                const currentVal = timeSelect.value;
                if (!currentVal || currentVal.trim() === '') continue;
                return true;
            }
            return false;
        };

        const iv = setInterval(() => {
            // 1) Try conventional select element
            const timeSelect = document.querySelector("#appointments_consulate_appointment_time, select[name*='time']");
            if (timeSelect && timeSelect.options && timeSelect.options.length > 1) {
                if (selectionKey && lastTimeSelectionKey === selectionKey && timeSelect.value && timeSelect.value.trim() !== '') {
                    clearInterval(iv);
                    resolve(true);
                    return;
                }
                // Choose first non-empty option and verify it sticks
                pickValidTimeOption().then(async (chosen) => {
                    if (!chosen) return;
                    clearInterval(iv);
                    const currentVal = timeSelect.value;
                    if (selectionKey) {
                        lastTimeSelectionKey = selectionKey;
                        lastTimeSelectionAt = Date.now();
                    }
                    console.log('attemptTimeSelection: selected time option', currentVal);
                    if (autobook) {
                        const enabled = await getAutobookEnabled();
                        if (enabled && isScheduleButtonActive()) {
                            const submitBtn = getScheduleButton();
                            if (submitBtn && typeof submitBtn.click === 'function') {
                                submitBtn.click();
                                console.log('attemptTimeSelection: auto-submitted');
                            }
                        }
                        else console.log('attemptTimeSelection: autobook disabled, not submitting');
                    }
                    resolve(true);
                });
                return;
            }

            // 2) Try clickable time slots (buttons/links/radios)
            const timeSlotSelectors = ['.time-slot', '.time-slots button', '.times button', '.available-time', 'input[name="appointments_consulate_appointment_time"]'];
            for (const sel of timeSlotSelectors) {
                const slot = document.querySelector(sel);
                if (slot) {
                    clearInterval(iv);
                    console.log('attemptTimeSelection: found clickable slot', slot);
                    if (slot.tagName && slot.tagName.toLowerCase() === 'input') {
                        slot.checked = true;
                        slot.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (typeof slot.click === 'function') {
                        slot.click();
                    }
                    if (autobook) {
                        setTimeout(async () => {
                            const submitBtn = document.querySelector('input[name="commit"], #appointments_submit, button[type="submit"]');
                            const enabled = await getAutobookEnabled();
                            if (enabled && submitBtn && typeof submitBtn.click === 'function') { submitBtn.click(); console.log('attemptTimeSelection: auto-submitted'); }
                            else console.log('attemptTimeSelection: autobook disabled, not submitting');
                            resolve(true);
                        }, 150);
                    } else {
                        resolve(true);
                    }
                    return;
                }
            }

            if (!apiFallbackTried && elapsed >= apiFallbackAfterMs) {
                apiFallbackTried = true;
                fetchTimesForSelectedDate().then(() => {
                    // allow the next interval tick to re-check populated options
                });
            }

            elapsed += intervalMs;
            if (elapsed >= maxMs) {
                clearInterval(iv);
                console.log('attemptTimeSelection: timed out');
                resolve(false);
            }
        }, intervalMs);
    });
}

// Directly fetch times API for selected date/facility and inject options into UI.
async function fetchTimesForSelectedDate() {
    if (!lastSelectedDate || !lastSelectedFacilityId || !SCHEDULE_ID) return false;
    try {
        const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
        const url = `https://ais.usvisa-info.com/en-ca/niv/schedule/${SCHEDULE_ID}/appointment/times/${lastSelectedFacilityId}.json?date=${encodeURIComponent(lastSelectedDate)}&appointments[expedite]=false`;
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-Token": csrfToken,
                "Accept": "application/json, text/javascript, */*; q=0.01"
            },
            credentials: 'same-origin'
        });
        if (!res.ok) return false;
        const data = await res.json();
        const times = Array.isArray(data) ? data : (data && data.available_times) ? data.available_times : [];
        if (!times || times.length === 0) return false;

        const timeSelect = document.querySelector("#appointments_consulate_appointment_time, select[name*='time']");
        if (timeSelect) {
            const existingValues = new Set(Array.from(timeSelect.options || []).map(o => o.value));
            for (const t of times) {
                if (!existingValues.has(t)) {
                    const opt = document.createElement('option');
                    opt.value = t;
                    opt.textContent = t;
                    timeSelect.appendChild(opt);
                }
            }
            timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
    } catch (e) {
        return false;
    }
}

// Click a date cell in the open calendar widget matching an ISO date string (yyyy-mm-dd)
function clickCalendarDate(dateStr, opts) {
    opts = opts || {};
    const fast = !!opts.fast;
    return new Promise((resolve) => {
        if (!dateStr) return resolve(false);
        let d = new Date(dateStr);
        if (isNaN(d)) return resolve(false);

        const day = String(d.getDate());
        const month = d.getMonth();
        const year = d.getFullYear();

        function performMouseSequence(el) {
            return new Promise(async res => {
                try {
                    const r = el.getBoundingClientRect();
                    const cx = Math.floor(r.left + r.width / 2);
                    const cy = Math.floor(r.top + r.height / 2);

                    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
                    el.dispatchEvent(new MouseEvent('mouseover', opts));
                    await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
                    el.dispatchEvent(new MouseEvent('mousemove', opts));
                    await new Promise(r => setTimeout(r, 15 + Math.random() * 25));
                    el.dispatchEvent(new MouseEvent('mousedown', opts));
                    // Human-like press duration
                    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
                    el.dispatchEvent(new MouseEvent('mouseup', opts));
                    await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
                    el.dispatchEvent(new MouseEvent('click', opts));
                    try { el.focus(); } catch (e) {}
                    res(true);
                } catch (e) { res(false); }
            });
        }

        // Quick immediate search (avoid waiting if calendar already rendered)
        (async () => {
            // Direct data-date attributes are typically fastest
            try {
                const direct = document.querySelector(`[data-date='${dateStr}'], [data-date*='${dateStr}'], [data-day='${day}'][data-month='${month}'][data-year='${year}']`);
                if (direct) {
                    const clickable = (direct.querySelector && (direct.querySelector('a, button') || direct)) || direct;
                    const ok = await performMouseSequence(clickable);
                    if (ok) return resolve(true);
                }
            } catch (e) {}

            // jQuery UI / Bootstrap anchors
            try {
                const jqSelector = `td[data-handler="selectDay"][data-month="${month}"][data-year="${year}"] a.ui-state-default`;
                const jqEl = document.querySelector(jqSelector);
                if (jqEl) {
                    const okJ = await performMouseSequence(jqEl);
                    if (okJ) return resolve(true);
                }
            } catch (e) {}

            // Fast scan for anchor with matching day text
            try {
                const anchors = document.querySelectorAll('.ui-datepicker-calendar td a, .ui-datepicker td a, .datepicker table td a, .datepicker-days td.day, .datepicker-days td a');
                for (const a of anchors) {
                    const txt = (a.innerText || a.textContent || '').trim();
                    if (txt === day) {
                        const td = a.closest('td');
                        const cls = (td && td.className || '').toLowerCase();
                        if (/other-month|ui-datepicker-other-month|old|new|disabled|muted/.test(cls)) continue;
                        const ok = await performMouseSequence(a);
                        if (ok) return resolve(true);
                    }
                }
            } catch (e) {}

            // If fast mode, reduce polling and add mutation observer rather than long polling
            const intervalMs = fast ? 50 : 120;
            const maxAttempts = fast ? 6 : 12;
            let attempts = 0;

            // MutationObserver fallback: resolves as soon as new nodes appear
            let observer;
            const obsHandler = async (mutationsList) => {
                for (const m of mutationsList) {
                    if (!m.addedNodes || m.addedNodes.length === 0) continue;
                    // Try the quick direct selector again when new nodes appear
                    const direct = document.querySelector(`[data-date='${dateStr}'], [data-date*='${dateStr}'], [data-day='${day}'][data-month='${month}'][data-year='${year}']`);
                    if (direct) {
                        if (observer) observer.disconnect();
                        const clickable = (direct.querySelector && (direct.querySelector('a, button') || direct)) || direct;
                        const ok = await performMouseSequence(clickable);
                        if (ok) return resolve(true);
                    }
                }
            };

            try {
                observer = new MutationObserver(obsHandler);
                observer.observe(document.body, { childList: true, subtree: true });
            } catch (e) { observer = null; }

            const iv = setInterval(async () => {
                attempts += 1;

                try {
                    const direct = document.querySelector(`[data-date='${dateStr}'], [data-date*='${dateStr}'], [data-day='${day}'][data-month='${month}'][data-year='${year}']`);
                    if (direct) {
                        const clickable = (direct.querySelector && (direct.querySelector('a, button') || direct)) || direct;
                        const ok = await performMouseSequence(clickable);
                        if (ok) { clearInterval(iv); if (observer) observer.disconnect(); return resolve(true); }
                    }

                    const containers = Array.from(document.querySelectorAll('.datepicker, .ui-datepicker, .calendar, .bootstrap-datetimepicker-widget'));
                    const searchContainers = containers.length ? containers : [document];
                    for (const cont of searchContainers) {
                        const elems = Array.from(cont.querySelectorAll('td, button, a, div'));
                        for (const el of elems) {
                            if (el.offsetParent === null) continue;
                            const txt = (el.innerText || el.textContent || '').trim();
                            if (txt !== day) continue;
                            const cls = (el.className || '').toLowerCase();
                            if (/disabled|muted|old|new|other-month|ui-datepicker-other-month/.test(cls)) continue;
                            const clickable = (el.querySelector && (el.querySelector('a, button') || el)) || el;
                            const ok = await performMouseSequence(clickable);
                            if (ok) { clearInterval(iv); if (observer) observer.disconnect(); return resolve(true); }
                        }
                    }
                } catch (e) { /* ignore per-iteration errors */ }

                if (attempts >= maxAttempts) { clearInterval(iv); if (observer) observer.disconnect(); return resolve(false); }
            }, intervalMs);
        })();
    });
}

// Return current autobook toggle from storage
function getAutobookEnabled() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(['toggleAutobook'], (data) => {
                resolve(!!data.toggleAutobook);
            });
        } catch (e) {
            resolve(false);
        }
    });
}

// Initial start trigger
function startCheckLoopOrPending() {
    try {
        chrome.storage.local.get([
            'pendingDates', 'pendingFacilityId', 'pendingCity', 'pendingAutobookEnabled',
            'startDate', 'endDate'
        ], (data) => {
            if (data && Array.isArray(data.pendingDates) && data.pendingDates.length > 0) {
                const userStart = data.startDate ? new Date(data.startDate) : new Date();
                const userEnd = data.endDate ? new Date(data.endDate) : new Date('2099-12-31');
                const startYmd = toYmd(userStart);
                const endYmd = toYmd(userEnd);

                const filtered = data.pendingDates.filter((dateStr) => {
                    const dateOnly = String(dateStr).slice(0, 10);
                    if (dateOnly < startYmd || dateOnly > endYmd) return false;
                    const dObj = parseIsoDateLocal(dateOnly);
                    return isBusinessDay(dObj);
                });

                if (filtered.length > 0) {
                    setPendingDates(data.pendingCity, filtered, data.pendingFacilityId, data.pendingAutobookEnabled, false);
                    tryNextDateFromQueue();
                    return;
                }

                try {
                    chrome.storage.local.remove(['pendingDates', 'pendingFacilityId', 'pendingCity', 'pendingAutobookEnabled']);
                } catch (e) {}
            }
            checkLoop();
        });
    } catch (e) {
        checkLoop();
    }
}

if ((window.location.href.includes('/schedule/') || window.location.href.includes('/appointment')) && !window.location.href.includes('/instructions')) {
    startCheckLoopOrPending();
    // Start human-like behavior simulation
    setTimeout(() => {
        startHumanBehaviorSimulation();
    }, 2000 + Math.random() * 3000);
}

// After successful login (pendingRelogin flag set), auto-restart the check loop
if (window.location.href.includes('/users/sign_in')) {
    chrome.storage.local.get(['pendingRelogin'], (data) => {
        if (data && data.pendingRelogin) {
            // Wait for auto-login to complete, then restart checkLoop
            setTimeout(() => {
                if (window.location.href.includes('/schedule/') || window.location.href.includes('/appointment')) {
                    console.log('✅ Re-logged in. Restarting appointment checker...');
                    checkLoop();
                }
                chrome.storage.local.remove('pendingRelogin', () => {});
            }, 3000);
        }
    });
}

// If we land on the continue_actions page after sign-in, go straight to the
// appointments page for the same schedule ID so the script can continue work.
if (window.location.href.includes('/continue_actions') && window.location.href.includes('/schedule/')) {
    const id = window.location.href.split('/schedule/')[1]?.split('/')[0];
        if (id && !window.location.href.includes('/appointment')) {
        const target = `${window.location.origin}/en-ca/niv/schedule/${id}/appointment`;
        console.log('Auto-redirecting to appointment page:', target);
        // small delay to allow page scripts to settle if needed
        setTimeout(() => { window.location.href = target; }, 300);
    }
}

// 4. AUTO-CLICK "CONTINUE" BUTTON OR ANCHOR ON NEXT PAGE
function clickContinueIfPresent() {
    const candidateSelectors = [
        'a.button.primary.small[href*="continue_actions"]',
        'a[href*="continue_actions"]',
        'button#continue',
        'button.continue',
        'button[data-role="continue"]',
        'input[type="submit"][value*="Continue"]',
        'input[type="button"][value*="Continue"]'
    ];

    for (const sel of candidateSelectors) {
        const el = document.querySelector(sel);
        if (el && typeof el.click === 'function') {
            el.click();
            return true;
        }
    }

    // Fallback: search by visible text for buttons/links/inputs
    const elems = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    for (const e of elems) {
        const text = (e.innerText || e.value || '').trim().toLowerCase();
        if (!text) continue;
        if (text === 'continue' || text.startsWith('continue')) {
            if (typeof e.click === 'function') {
                e.click();
                return true;
            }
        }
    }

    return false;
}

// Periodically try to click a "Continue" button/anchor for up to 20s
(function autoClickContinueWatcher() {
    if (window.location.href.includes('/instructions')) return;
    const maxMs = 20000;
    const intervalMs = 1200;
    let elapsed = 0;
    const t = setInterval(() => {
        if (clickContinueIfPresent() || elapsed >= maxMs) {
            clearInterval(t);
            return;
        }
        elapsed += intervalMs;
    }, intervalMs);
})();

// Start human behavior simulation on relevant pages
if (window.location.href.includes('usvisa-info.com') && 
    !window.location.href.includes('/instructions')) {
    // Start after page load with random delay
    window.addEventListener('load', () => {
        setTimeout(() => {
            startHumanBehaviorSimulation();
        }, 3000 + Math.random() * 5000);
    });
}

// Stop simulation before page unload to avoid errors
window.addEventListener('beforeunload', () => {
    stopHumanBehaviorSimulation();
});