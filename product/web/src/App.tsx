import { useEffect, useState } from "react";
import { parseUserCodeFromHash } from "./api/device.js";
import { Activity } from "./pages/Activity";
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
  } else if (route === "/machines") {
    screen = (
      <Machines
        onOpen={(id) => navigate(`/machines/${id}`)}
        onProvision={() => navigate("/provisioning")}
        onNeedLogin={() => navigate("/login")}
      />
    );
  }

  return <main className={authRoute ? "canvas" : "canvas canvas-page"}>{screen}</main>;
}
