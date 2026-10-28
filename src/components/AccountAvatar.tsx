import type { Account } from "../api";
import { accountInitials, colourOf } from "../colours";

/** An account as a round badge: its initials on its colour. */
export function AccountAvatar(props: { account: Account; accounts: Account[]; size?: number }) {
  const size = () => props.size ?? 24;
  return (
    <span
      class="account-avatar"
      aria-hidden="true"
      style={{ background: colourOf(props.accounts, props.account.id), width: `${size()}px`, height: `${size()}px`, "font-size": `${Math.round(size() * 0.42)}px` }}
    >
      {accountInitials(props.account)}
    </span>
  );
}
