import { getSystemBaseline, UNION_SYSTEM_VERSION } from '@union/shared';

export function App() {
  const baseline = getSystemBaseline();

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #ccc', paddingBottom: '1rem', marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.8rem', color: '#111' }}>UNIÓN</h1>
        <p style={{ margin: '0.5rem 0 0 0', color: '#666', fontSize: '1rem' }}>Web Foundation</p>
      </header>
      <main>
        <div style={{ display: 'inline-block', padding: '0.4rem 0.8rem', background: '#e6f4ea', color: '#137333', borderRadius: '4px', fontWeight: 'bold' }}>
          Status: READY
        </div>
        <div style={{ marginTop: '1.5rem', color: '#444', fontSize: '0.9rem' }}>
          <p><strong>System Architecture:</strong> {baseline.name}</p>
          <p><strong>Baseline Version:</strong> {UNION_SYSTEM_VERSION}</p>
          <p><strong>Architecture Status:</strong> {baseline.status}</p>
        </div>
      </main>
    </div>
  );
}

export default App;
