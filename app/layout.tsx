import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AgentWallet",
  description: "Stripe for AI agents — self-hosted single user.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
