export interface AuthRecoveryState {
  activeSessionId?: string;
  authRecoveryTried: boolean;
}

/**
 * Claim the one transparent auth retry for one session's current failure
 * streak. The returned id is the history that the owning process must reload.
 */
export function beginAuthRecovery(state: AuthRecoveryState): string | undefined {
  if (!state.activeSessionId || state.authRecoveryTried) return undefined;
  state.authRecoveryTried = true;
  return state.activeSessionId;
}
