import { useEffect, useState } from "react";
import { parseUserCodeFromHash } from "./api/device.js";
import { cloud } from "./api/cloud.js";
import { isImpersonating, shouldShowAdminNav } from "./api/admin.js";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Admin";
import { CliLogin } from "./pages/CliLogin";
import { Login } from "./pages/Login";
import { LegalPage } from "./pages/Legal";

function currentPath() {
  return window.location.pathname.replace(/\/$/, "") || "/";
}

function go(to: string) {
  window.history.pushState({}, "", to + window.location.hash);
}

function nodeIdFrom(route: string) {
  const match = /^\/activity\/([^/]+)$/.exec(route);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const [route, setRoute] = useState(currentPath);
  const [nav, setNav] = useState({ signedIn: false, showAdmin: false, impersonating: false });
  const [sessionTick, setSessionTick] = useState(0);

  useEffect(() => {
    if (currentPath() === "/") {
      window.history.replaceState({}, "", "/login" + window.location.hash);
      setRoute("/login");
    }
    const onPop = () => setRoute(currentPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(to: string) {
    go(to);
    setRoute(currentPath());
  }

  const nodeId = nodeIdFrom(route);
  const authRoute = route === "/login" || route === "/cli-login";
  const legalPage = route === "/privacy" || route === "/terms" || route === "/support"
    ? route.slice(1) as "privacy" | "terms" | "support"
    : null;
  const publicRoute = authRoute || legalPage !== null;

  useEffect(() => {
    if (publicRoute) {
      setNav({ signedIn: false, showAdmin: false, impersonating: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await cloud.authClient.getSession();
        if (cancelled) return;
        const user = result?.data?.user;
        const session = result?.data?.session;
        setNav({
          signedIn: Boolean(user),
          showAdmin: shouldShowAdminNav({ signedIn: Boolean(user), role: user?.role }),
          impersonating: isImpersonating(session),
        });
      } catch {
        if (!cancelled) setNav({ signedIn: false, showAdmin: false, impersonating: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicRoute, route, sessionTick]);

  async function stopImpersonating() {
    try {
      await cloud.authClient.admin.stopImpersonating();
    } catch (err) {
      console.error(err);
    } finally {
      setSessionTick((tick) => tick + 1);
    }
  }

  let screen = (
    <Login
      onSignedIn={() => {
        if (parseUserCodeFromHash(window.location.hash)) navigate("/cli-login");
        else navigate("/activity");
      }}
      onSignedUp={() => navigate("/activity")}
    />
  );
  if (legalPage) {
    screen = <LegalPage page={legalPage} onNavigate={navigate} />;
  } else if (route === "/cli-login") {
    screen = (
      <CliLogin
        onApproved={() => navigate("/activity")}
        onSignedUp={() => navigate("/activity")}
      />
    );
  } else if (route === "/admin") {
    screen = (
      <Admin
        onNeedLogin={() => navigate("/login")}
        onForbidden={() => navigate("/activity")}
        onImpersonated={() => {
          setSessionTick((tick) => tick + 1);
          navigate("/activity");
        }}
      />
    );
  } else if (route === "/activity" || nodeId) {
    screen = <Activity nodeId={nodeId} />;
  }

  return (
    <main className={legalPage ? "canvas canvas-legal" : authRoute ? "canvas" : "canvas canvas-page"}>
      {!publicRoute && nav.signedIn ? (
        <nav className="chrome" aria-label="Console">
          <button type="button" className="btn-text" onClick={() => navigate("/activity")}>
            Activity
          </button>
          {nav.showAdmin || nav.impersonating ? (
            <div className="chrome-end">
              {nav.showAdmin ? (
                <button type="button" className="btn-text" onClick={() => navigate("/admin")}>
                  Admin
                </button>
              ) : null}
              {nav.impersonating ? (
                <button type="button" className="btn-text" onClick={() => void stopImpersonating()}>
                  Stop impersonating
                </button>
              ) : null}
            </div>
          ) : null}
        </nav>
      ) : null}
      {screen}
    </main>
  );
}
