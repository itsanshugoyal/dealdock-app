import { SignIn } from "@clerk/nextjs";

const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default function SignInPage() {
  if (!CLERK_ENABLED) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center", color: "#a3a3a3", fontSize: 14 }}>
          <p style={{ color: "#fafafa", fontWeight: 700, marginBottom: 8 }}>
            Auth not configured
          </p>
          <p>
            Create a Clerk application and set{" "}
            <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> +{" "}
            <code>CLERK_SECRET_KEY</code> in <code>.env</code>, then rebuild.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <SignIn />
    </main>
  );
}
