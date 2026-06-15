import { useState, useEffect } from 'react'

type LogEntry = {
  timestamp: number
  level: 'log' | 'error' | 'warning' | 'info'
  message: string
}

export function useDebugConsole() {
  const [logs, setLogs] = useState<LogEntry[]>([])

  useEffect(() => {
    // Capture console methods
    const originalLog = console.log
    const originalError = console.error
    const originalWarn = console.warn
    const originalInfo = console.info

    const addLog = (level: LogEntry['level'], ...args: any[]) => {
      const message = args.map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2)
          } catch {
            return String(arg)
          }
        }
        return String(arg)
      }).join(' ')

      setLogs(prev => [...prev.slice(-99), { timestamp: Date.now(), level, message }])
    }

    console.log = (...args) => {
      originalLog(...args)
      addLog('log', ...args)
    }
    console.error = (...args) => {
      originalError(...args)
      addLog('error', ...args)
    }
    console.warn = (...args) => {
      originalWarn(...args)
      addLog('warning', ...args)
    }
    console.info = (...args) => {
      originalInfo(...args)
      addLog('info', ...args)
    }

    return () => {
      console.log = originalLog
      console.error = originalError
      console.warn = originalWarn
      console.info = originalInfo
    }
  }, [])

  return logs
}

export default function DebugConsole({ logs }: { logs: LogEntry[] }) {
  const [isOpen, setIsOpen] = useState(false)

  const levelColor = (level: LogEntry['level']) => {
    switch (level) {
      case 'error': return '#ef4444'
      case 'warning': return '#f97316'
      case 'info': return '#3b82f6'
      default: return '#9fb0cc'
    }
  }

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 1000,
      background: '#0f1419',
      borderTop: '1px solid #1e293b',
      display: 'flex',
      flexDirection: 'column',
      maxHeight: isOpen ? '300px' : '40px',
      transition: 'max-height 0.3s ease'
    }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          padding: '8px 16px',
          background: 'transparent',
          border: 'none',
          color: '#9fb0cc',
          cursor: 'pointer',
          textAlign: 'left',
          fontSize: '12px',
          fontFamily: 'monospace',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <span>{isOpen ? '▼' : '▶'}</span> Debug Console ({logs.length} logs)
      </button>
      
      {isOpen && (
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '8px 16px',
          fontFamily: 'monospace',
          fontSize: '11px',
          lineHeight: '1.4'
        }}>
          {logs.length === 0 ? (
            <div style={{ color: '#475569' }}>No logs yet...</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} style={{ color: levelColor(log.level), marginBottom: '4px' }}>
                <span style={{ color: '#64748b' }}>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                {' '}
                <span style={{ color: '#94a3b8' }}>[{log.level.toUpperCase()}]</span>
                {' '}
                {log.message}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
