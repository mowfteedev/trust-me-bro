import React, { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { ClusterOverview } from "./components/ClusterOverview.js";
import { AuditLog } from "./components/AuditLog.js";
import { TerminalModal } from "./components/TerminalModal.js";
import { useSession } from "./hooks/useSession.js";
import { ConsoleLayout, ConsoleTab } from "./layouts/ConsoleLayout.js";
import { LoginPage } from "./pages/LoginPage.js";
import { NodeItem } from "./types/index.js";

export const App: React.FC = () => {
  const session = useSession();
  const [selectedTerminalNode, setSelectedTerminalNode] =
    useState<NodeItem | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [activeTab, setActiveTab] = useState<ConsoleTab>("dashboard");

  useEffect(() => {
    if (!session.currentUser) setSelectedTerminalNode(null);
  }, [session.currentUser]);

  const handleLogin = async (password: string) => {
    const loggedIn = await session.login(password);
    if (loggedIn) setActiveTab("dashboard");
    return loggedIn;
  };

  const themeButton = (
    <button
      className="icon-button"
      onClick={() => setIsDarkMode(!isDarkMode)}
      title={
        isDarkMode ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"
      }
    >
      {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );

  if (!session.currentUser) {
    return (
      <LoginPage
        isDarkMode={isDarkMode}
        themeButton={themeButton}
        username={session.username}
        onUsernameChange={session.setUsername}
        loginError={session.loginError}
        logoutWarning={session.logoutWarning}
        isSubmitting={session.isSubmitting}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <ConsoleLayout
      currentUser={session.currentUser}
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onLogout={session.logout}
      isDarkMode={isDarkMode}
      themeButton={themeButton}
      terminal={
        selectedTerminalNode && (
          <TerminalModal
            node={selectedTerminalNode}
            isOpen
            onClose={() => setSelectedTerminalNode(null)}
          />
        )
      }
    >
      {activeTab === "audit" && session.currentUser.role === "ADMIN" ? (
        <AuditLog />
      ) : (
        <ClusterOverview
          currentUser={session.currentUser}
          onOpenTerminal={setSelectedTerminalNode}
          focusSection={activeTab === "fleet" ? "fleet" : "dashboard"}
        />
      )}
    </ConsoleLayout>
  );
};
