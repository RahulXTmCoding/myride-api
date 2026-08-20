import { Injectable } from '@nestjs/common';

export type Platform = 'ios' | 'android';

export interface VersionCheckResponse {
  /** Latest published app version */
  latestVersion: string;
  /** Any app version below this MUST update to continue */
  minSupportedVersion: string;
  /** True if the client is running an unsupported build */
  forceUpdate: boolean;
  /** True if a newer (but non-mandatory) version is available */
  updateAvailable: boolean;
  /** Deep link to Play Store / App Store for the correct platform */
  updateUrl: string;
  /** User-facing message to show in the blocking modal */
  message: string;
  /** Optional soft-release notes */
  releaseNotes?: string;
}

/**
 * Version registry.
 *
 * These values are intentionally hard-coded here so an update to the
 * minimum-supported version is a code deploy (fast, auditable, no
 * separate admin panel needed). Move to DB or env vars later if the
 * product needs to bump versions without a redeploy.
 */
const REGISTRY: Record<
  Platform,
  {
    latestVersion: string;
    minSupportedVersion: string;
    updateUrl: string;
  }
> = {
  ios: {
    latestVersion: '1.0.0',
    minSupportedVersion: '1.0.0',
    updateUrl: 'https://apps.apple.com/app/id0000000000', // TODO: real App Store link
  },
  android: {
    latestVersion: '1.0.0',
    minSupportedVersion: '1.0.0',
    updateUrl: 'https://play.google.com/store/apps/details?id=com.myride.app',
  },
};

@Injectable()
export class VersionService {
  check(rawPlatform: string, currentVersion: string): VersionCheckResponse {
    const platform: Platform =
      rawPlatform?.toLowerCase() === 'ios' ? 'ios' : 'android';
    const entry = REGISTRY[platform];

    const current = parseVersion(currentVersion);
    const min = parseVersion(entry.minSupportedVersion);
    const latest = parseVersion(entry.latestVersion);

    const forceUpdate = compare(current, min) < 0;
    const updateAvailable = compare(current, latest) < 0;

    return {
      latestVersion: entry.latestVersion,
      minSupportedVersion: entry.minSupportedVersion,
      forceUpdate,
      updateAvailable,
      updateUrl: entry.updateUrl,
      message: forceUpdate
        ? 'A critical update is required to continue using Roamly. Please update from the store to keep riding.'
        : updateAvailable
          ? 'A new version of Roamly is available with improvements and fixes.'
          : 'You are on the latest version.',
    };
  }
}

/** Parse "1.2.3" → [1,2,3]; missing parts default to 0; NaN → 0. */
function parseVersion(v: string): number[] {
  if (!v || typeof v !== 'string') return [0, 0, 0];
  return v
    .split('.')
    .slice(0, 3)
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Semver-lite compare: negative if a<b, 0 if equal, positive if a>b. */
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
