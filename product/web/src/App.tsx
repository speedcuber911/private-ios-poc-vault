import { useEffect, useState } from "react";
import { Login } from "./pages/Login";

function currentPath() {
  return window.location.pathname.replace(/\/$/, "") || "/";
}

function go(to: string) {
  window.history.pushState({}, "", to + window.location.hash);
}

function Stub({ title, status }: { title: string; status: string }) {
  return (
    <div className="stub">
      <h1>{title}</h1>
      <p className="stub-status">{status}</p>
    </div>
  );
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

  let screen = (
    <Login
      onSignedIn={() => navigate("/machines")}
      onSignedUp={() => navigate("/provisioning")}
    />
  );
  if (route === "/provisioning") {
    screen = <Stub title="Your machine" status="Creating" />;
  } else if (route === "/machines") {
    screen = <Stub title="Machines" status="No machines yet" />;
  }

  return <main className="canvas">{screen}</main>;
}
