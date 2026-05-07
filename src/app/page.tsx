import Link from "next/link";

export default function HomePage() {
  return (
    <div style={{ padding: "2rem" }}>
      <h1>Campus Hunt</h1>
      <p style={{ marginTop: "1rem" }}>
        <Link href="/campus" style={{ color: "#4a9eff" }}>
          Open 3D Campus Map →
        </Link>
      </p>
    </div>
  );
}
