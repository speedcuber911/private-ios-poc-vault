import { useEffect, useState } from "react";
import { parseUserCodeFromHash } from "./api/device.js";
import { cloud } from "./api/cloud.js";
import { isImpersonating, shouldShowAdminNav } from "./api/admin.js";
import { Activity } from "./pages/Activity";
import { Admin } from "./pages/Admin";
import { CliLogin } from "./pages/CliLogin";
import { Login } from "./pages/Login";
import { Machines } from "./pages/Machines";
import { Provisioning } from "./pages/Provisioning";

function currentPath() {
  return window.location.pathname.replace(/\/$/, "") || "/";
}

function go(to: string) {
  window.history.pushState({}, "", to + window.location.hash);
}

function machineIdFrom(route: string) {
  const match = /^\/machines\/([^/]+)$/.exec(route);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const [route, setRoute] = useState(currentPath);
  const [nav, setNav] = useState({ showAdmin: false, impersonating: false });
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

  const machineId = machineIdFrom(route);
  const authRoute = route === "/login" || route === "/cli-login";

  useEffect(() => {
    if (authRoute) {
      setNav({ showAdmin: false, impersonating: false });
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
          showAdmin: shouldShowAdminNav({ signedIn: Boolean(user), role: user?.role }),
          impersonating: isImpersonating(session),
        });
      } catch {
        if (!cancelled) setNav({ showAdmin: false, impersonating: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authRoute, route, sessionTick]);

  async function stopImpersonating() {
    await cloud.authClient.admin.stopImpersonating();
    setSessionTick((tick) => tick + 1);
  }

  let screen = (
    <Login
      onSignedIn={() => {
        if (parseUserCodeFromHash(window.location.hash)) navigate("/cli-login");
        else navigate("/machines");
      }}
      onSignedUp={() => navigate("/provisioning")}
    />
  );
  if (route === "/cli-login") {
    screen = (
      <CliLogin
        onApproved={() => navigate("/machines")}
        onSignedUp={() => navigate("/provisioning")}
      />
    );
  } else if (route === "/provisioning") {
    screen = (
      <Provisioning
        onReady={(nodeId) => navigate(nodeId ? `/machines/${nodeId}` : "/machines")}
        onNeedLogin={() => navigate("/login")}
      />
    );
  } else if (machineId) {
    screen = <Activity nodeId={machineId} onBack={() => navigate("/machines")} />;
  } else if (route === "/admin") {
    screen = (
      <Admin
        onNeedLogin={() => navigate("/login")}
        onForbidden={() => navigate("/machines")}
        onImpersonated={() => {
          setSessionTick((tick) => tick + 1);
          navigate("/machines");
        }}
      />
    );
  } else if (route === "/machines") {
    screen = (
      <Machines
        onOpen={(id) => navigate(`/machines/${id}`)}
        onProvision={() => navigate("/provisioning")}
        onNeedLogin={() => navigate("/login")}
      />
    );
  }

  return (
    <main className={authRoute ? "canvas" : "canvas canvas-page"}>
      {!authRoute && (nav.showAdmin || nav.impersonating) ? (
        <nav className="chrome" aria-label="Console">
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
        </nav>
      ) : null}
      {screen}
    </main>
  );
}
