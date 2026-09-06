'use client';

import { useEffect } from 'react';

export const IOS_CHROME_RELOAD_COUNT_KEY = 'mainworker:ios-chrome-restoration-reload-count';
export const IOS_CHROME_LAST_RELOAD_AT_KEY = 'mainworker:ios-chrome-restoration-last-reload-at';
const RELOAD_GUARD_KEY = 'mainworker:ios-chrome-restoration-reload-guard';
const RELOAD_GUARD_MS = 5_000;
const RELOAD_DELAY_MS = 120;
const RESTORING_ATTRIBUTE = 'data-ios-chrome-restoring';

function isIOSChrome() {
  const iosDevice = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return iosDevice && /CriOS\//.test(navigator.userAgent);
}

function navigationType() {
  return (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type || null;
}

function readNumber(key: string) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // A one-shot reload still works when storage is unavailable.
  }
}

export function useIOSChromeRestorationReload() {
  useEffect(() => {
    if (!isIOSChrome()) return;

    history.scrollRestoration = 'manual';
    let reloadTimer = 0;
    const revealTimer = window.setTimeout(() => document.documentElement.removeAttribute(RESTORING_ATTRIBUTE), 4_000);
    let reloadStarted = false;

    const reloadRestoredPage = (restoredFromPageCache = false) => {
      if (reloadStarted || (!restoredFromPageCache && navigationType() !== 'back_forward')) return;
      if (document.documentElement.getAttribute(RESTORING_ATTRIBUTE) === 'true') return;
      const now = Date.now();
      const lastAttemptAt = readNumber(RELOAD_GUARD_KEY);
      if (lastAttemptAt > 0 && now - lastAttemptAt < RELOAD_GUARD_MS) return;

      reloadStarted = true;
      document.documentElement.setAttribute(RESTORING_ATTRIBUTE, 'true');
      writeNumber(RELOAD_GUARD_KEY, now);
      writeNumber(IOS_CHROME_LAST_RELOAD_AT_KEY, now);
      writeNumber(IOS_CHROME_RELOAD_COUNT_KEY, readNumber(IOS_CHROME_RELOAD_COUNT_KEY) + 1);
      reloadTimer = window.setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    };

    const onPageShow = (event: PageTransitionEvent) => reloadRestoredPage(event.persisted);
    window.addEventListener('pageshow', onPageShow);
    reloadRestoredPage();

    return () => {
      window.removeEventListener('pageshow', onPageShow);
      window.clearTimeout(reloadTimer);
      window.clearTimeout(revealTimer);
    };
  }, []);
}
