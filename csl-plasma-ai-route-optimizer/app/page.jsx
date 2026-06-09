export default function Home() {
  return (
    <html>
      <body style={{ margin: 0 }}>
        <a
          href="/audit"
          style={{
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 10,
            background: '#0b63ce',
            color: 'white',
            padding: '10px 14px',
            borderRadius: 8,
            fontFamily: 'Arial, sans-serif',
            fontSize: 14,
            fontWeight: 700,
            textDecoration: 'none',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.18)'
          }}
        >
          Audit Dashboard
        </a>
        <iframe src="/network-map.html" style={{ border: 0, width: '100vw', height: '100vh' }} />
      </body>
    </html>
  );
}
