import { useEffect, useRef, useState } from "react";
import { cloud } from "../api/cloud.js";
import {
  admin as defaultAdmin,
  adminRouteFor,
  canImpersonate,
  canUpgrade,
  confirmAndUpgrade,
  hostedMachineId,
  isAdminRole,
  nodesMax,
  roleActionLabel,
  trialStateWord,
  upgradeErrorWord,
} from "../api/admin.js";
import { RelayMark } from "./Login";

type AccountRow = {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
  banned?: boolean | null;
  trial?: { state?: string; nodeId?: string | null } | null;
  nodes?: { id: string }[];
  entitlements?: { feature: string; value: string }[];
};

function accountsFrom(json: { accounts?: AccountRow[] } | AccountRow[] | null) {
  if (Array.isArray(json)) return json;
  return json?.accounts ?? [];
}

export function Admin({
  onNeedLogin,
  onForbidden,
  onImpersonated,
}: {
  onNeedLogin: () => void;
  onForbidden: () => void;
  onImpersonated: () => void;
}) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [upgradingId, setUpgradingId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const onNeedLoginRef = useRef(onNeedLogin);
  const onForbiddenRef = useRef(onForbidden);
  onNeedLoginRef.current = onNeedLogin;
  onForbiddenRef.current = onForbidden;

  async function loadAccounts() {
    const listed = await defaultAdmin.listAccounts();
    if (listed.status === 401) {
      onNeedLoginRef.current();
      return false;
    }
    if (listed.status === 403) {
      onForbiddenRef.current();
      return false;
    }
    if (!listed.ok) {
      setError("Can't reach the Relay control plane.");
      return false;
    }
    setAccounts(accountsFrom(listed.json));
    return true;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await cloud.authClient.getSession();
        if (cancelled) return;
        const user = session?.data?.user;
        const dest = adminRouteFor({ signedIn: Boolean(user), role: user?.role });
        if (dest === "/login") {
          onNeedLoginRef.current();
          return;
        }
        if (dest === "/machines") {
          onForbiddenRef.current();
          return;
        }
        await loadAccounts();
      } catch {
        if (!cancelled) setError("Can't reach the Relay control plane.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function upgrade(account: AccountRow) {
    if (!canUpgrade(account) || upgradingId) return;
    setUpgradingId(account.id);
    setRowError((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    try {
      const result = await confirmAndUpgrade(account.id, {
        upgrade: (id) => defaultAdmin.upgradeAccount(id),
      });
      if ("cancelled" in result && result.cancelled) return;
      const word = upgradeErrorWord(result);
      if (word) {
        setRowError((current) => ({ ...current, [account.id]: word }));
        return;
      }
      await loadAccounts();
    } catch {
      setRowError((current) => ({ ...current, [account.id]: "FAILED" }));
    } finally {
      setUpgradingId(null);
    }
  }

  async function runAuthAction(accountId: string, action: () => Promise<{ error?: { message?: string } | null }>) {
    if (actingId) return;
    setActingId(accountId);
    setError(null);
    try {
      const result = await action();
      if (result?.error) {
        setError(String(result.error.message || "FAILED").toUpperCase());
        return false;
      }
      return true;
    } catch {
      setError("Can't reach the Relay control plane.");
      return false;
    } finally {
      setActingId(null);
    }
  }

  async function ban(account: AccountRow) {
    const ok = await runAuthAction(account.id, () =>
      cloud.authClient.admin.banUser({ userId: account.id }),
    );
    if (ok) await loadAccounts();
  }

  async function impersonate(account: AccountRow) {
    if (!canImpersonate(account)) return;
    const ok = await runAuthAction(account.id, () =>
      cloud.authClient.admin.impersonateUser({ userId: account.id }),
    );
    if (ok) onImpersonated();
  }

  async function toggleRole(account: AccountRow) {
    const role = isAdminRole(account.role) ? "user" : "admin";
    const ok = await runAuthAction(account.id, () =>
      cloud.authClient.admin.setRole({ userId: account.id, role }),
    );
    if (ok) await loadAccounts();
  }

  return (
    <div className="page page-admin">
      <div className="brand">
        <RelayMark />
        <div>
          <h1 className="page-title">Admin</h1>
        </div>
      </div>
      <button type="button" className="btn-text back" onClick={onForbidden}>
        Machines
      </button>

      {!loading && accounts.length === 0 && !error ? <p className="muted">No accounts yet</p> : null}

      <ul className="machine-list">
        {accounts.map((account) => {
          const state = trialStateWord(account.trial);
          const machineId = hostedMachineId(account);
          const max = nodesMax(account.entitlements);
          const eligible = canUpgrade(account);
          const impersonateOk = canImpersonate(account);
          const rowWord = rowError[account.id];
          return (
            <li key={account.id} className="admin-row">
              <div className="admin-row-top">
                <span className="machine-row-name">{account.email || account.name || account.id}</span>
                <span className="status-word">{state}</span>
              </div>
              {account.name && account.email ? <span className="muted admin-name">{account.name}</span> : null}
              <div className="admin-meta">
                {machineId ? <span className="kind-word">{machineId}</span> : null}
                <span className="kind-word">MAX {max}</span>
                <span className="kind-word">{isAdminRole(account.role) ? "ADMIN" : "USER"}</span>
                {account.banned ? <span className="status-word status-error">BANNED</span> : null}
              </div>
              {rowWord ? (
                <p className="error" role="alert">
                  {rowWord}
                </p>
              ) : null}
              <div className="admin-row-actions">
                <button
                  type="button"
                  className="btn-primary compact"
                  disabled={!eligible || upgradingId === account.id}
                  onClick={() => void upgrade(account)}
                >
                  Upgrade
                </button>
                <button
                  type="button"
                  className="btn-text"
                  disabled={Boolean(account.banned) || actingId === account.id}
                  onClick={() => void ban(account)}
                >
                  Ban
                </button>
                {impersonateOk ? (
                  <button
                    type="button"
                    className="btn-text"
                    disabled={actingId === account.id}
                    onClick={() => void impersonate(account)}
                  >
                    Impersonate
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn-text"
                  disabled={actingId === account.id}
                  onClick={() => void toggleRole(account)}
                >
                  {roleActionLabel(account.role)}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
