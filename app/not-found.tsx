import Link from "next/link";

export default function NotFound() {
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div style={{ textAlign: "center", maxWidth: "32rem" }}>
        <p style={{ margin: 0, fontSize: "0.875rem", letterSpacing: "0.12em", textTransform: "uppercase", color: "#6b7280" }}>
          404
        </p>
        <h1 style={{ margin: "0.75rem 0 1rem", fontSize: "clamp(2rem, 5vw, 3rem)" }}>
          Page not found
        </h1>
        <p style={{ margin: 0, color: "#4b5563", lineHeight: 1.6 }}>
          The page you are looking for does not exist or may have moved.
        </p>
        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: "1.5rem",
            padding: "0.75rem 1.25rem",
            borderRadius: "0.75rem",
            background: "#111827",
            color: "#ffffff",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
