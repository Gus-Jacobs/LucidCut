import React, { useState } from 'react';
import './ReviewScreen.css';
import type { Detection } from '../types';

interface ReviewScreenProps {
  detections: Detection[];
  onSubmit: (feedback: ReviewFeedback[]) => void;
  onSkip: () => void;
}

interface ReviewFeedback {
  id: string;
  type: 'swear' | 'unsafe';
  action: 'keep' | 'remove' | 'change_severity' | 'add';
  newSeverity?: 'hard' | 'soft';
  notes?: string;
  start?: number;
  end?: number;
}

const ReviewScreen: React.FC<ReviewScreenProps> = ({ detections, onSubmit, onSkip }) => {
  const [feedback, setFeedback] = useState<ReviewFeedback[]>(
    detections.map(d => ({
      id: d.id,
      type: d.type,
      action: 'keep',
      newSeverity: d.nsfw_severity,
    }))
  );

  // Log for debug console
  React.useEffect(() => {
    const swears = detections.filter(d => d.type === 'swear').length
    const imagery = detections.filter(d => d.type === 'unsafe').length
    console.log(`📋 Review screen loaded: ${swears} profanity + ${imagery} imagery detections`)
  }, [detections])

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddManual, setShowAddManual] = useState(false);
  const [manualStart, setManualStart] = useState('');
  const [manualEnd, setManualEnd] = useState('');
  const [manualSeverity, setManualSeverity] = useState<'hard' | 'soft'>('soft');
  const [manualNotes, setManualNotes] = useState('');

  const handleAction = (id: string, action: 'keep' | 'remove' | 'change_severity') => {
    console.log(`[ReviewScreen] Setting action for ${id} to ${action}`);
    setFeedback(prev => {
      const updated = prev.map(f => {
        if (f.id === id) {
          console.log(`[ReviewScreen] Updating ${f.id}: ${f.action} → ${action}`);
          return { ...f, action };
        }
        return f;
      });
      console.log('[ReviewScreen] New feedback state:', updated);
      return updated;
    });
  };

  const handleSeverityChange = (id: string, severity: 'hard' | 'soft') => {
    console.log(`[ReviewScreen] Changing severity for ${id} to ${severity}`);
    setFeedback(prev =>
      prev.map(f =>
        f.id === id ? { ...f, newSeverity: severity, action: 'change_severity' } : f
      )
    );
  };

  const handleNotes = (id: string, notes: string) => {
    setFeedback(prev =>
      prev.map(f =>
        f.id === id ? { ...f, notes } : f
      )
    );
  };

  const handleAddManual = () => {
    if (!manualStart || !manualEnd) {
      alert('Please enter both start and end times');
      return;
    }
    const start = parseFloat(manualStart);
    const end = parseFloat(manualEnd);
    if (isNaN(start) || isNaN(end) || start >= end) {
      alert('Invalid times - end must be after start');
      return;
    }
    const newId = `manual-${Date.now()}`;
    setFeedback(prev => [...prev, {
      id: newId,
      type: 'unsafe',
      action: 'add',
      newSeverity: manualSeverity,
      notes: manualNotes,
      start,
      end
    }]);
    setManualStart('');
    setManualEnd('');
    setManualSeverity('soft');
    setManualNotes('');
    setShowAddManual(false);
  };

  const unsafeDetections = detections.filter(d => d.type === 'unsafe');
  const swearDetections = detections.filter(d => d.type === 'swear');

  const stats = {
    total: detections.length,
    keep: feedback.filter(f => f.action === 'keep').length,
    remove: feedback.filter(f => f.action === 'remove').length,
    change: feedback.filter(f => f.action === 'change_severity').length,
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>📋 Review Detections</h2>
        <p style={styles.subtitle}>
          Confirm or correct {detections.length} detected issues. This feedback helps improve accuracy.
        </p>
      </div>

      <div style={styles.statsBar}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Keep:</span>
          <span style={styles.statValue}>{stats.keep}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Remove:</span>
          <span style={styles.statValue}>{stats.remove}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Change:</span>
          <span style={styles.statValue}>{stats.change}</span>
        </div>
      </div>

      <div style={styles.content}>
        {unsafeDetections.length > 0 && (
          <>
            <h3 style={styles.sectionTitle}>🚨 Imagery Detections ({unsafeDetections.length})</h3>
            <div style={styles.detectionList}>
              {unsafeDetections.map((detection) => {
                const f = feedback.find(fb => fb.id === detection.id);
                const isExpanded = expandedId === detection.id;
                const isSeverityChange = f?.action === 'change_severity';

                return (
                  <div key={detection.id} style={styles.detectionCard}>
                    <div
                      style={{
                        ...styles.detectionHeader,
                        backgroundColor:
                          f?.action === 'remove'
                            ? '#2a2020'
                            : isSeverityChange
                            ? '#2a2a1f'
                            : '#1f2a2a',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : detection.id)}
                    >
                      <span style={styles.detectionTime}>{detection.time}</span>
                      <span style={styles.detectionText}>{detection.text}</span>
                      <span style={styles.detectionConfidence}>
                        {(detection.confidence * 100).toFixed(0)}%
                      </span>
                      <span style={styles.expandIcon}>{isExpanded ? '▼' : '▶'}</span>
                    </div>

                    {isExpanded && (
                      <div style={styles.detectionExpanded}>
                        <div style={styles.detectionInfo}>
                          <div>
                            <strong>Type:</strong> {detection.nsfw_severity}
                          </div>
                          <div>
                            <strong>Duration:</strong> {detection.end - detection.start} seconds
                          </div>
                          <div>
                            <strong>Confidence:</strong> {(detection.confidence * 100).toFixed(1)}%
                          </div>
                          {detection.regions && detection.regions.length > 0 && (
                            <div>
                              <strong>Regions:</strong> {Array.from(new Set(detection.regions.map(r => r.label))).join(', ')}
                            </div>
                          )}
                        </div>

                        <div style={styles.detectionActions}>
                          <div style={styles.actionGroup}>
                            <label style={styles.actionLabel}>
                              <input
                                type="radio"
                                name={`action-${detection.id}`}
                                checked={f?.action === 'keep'}
                                onChange={() => handleAction(detection.id, 'keep')}
                              />
                              <span style={{ marginLeft: '8px' }}>✓ Keep (Correct)</span>
                            </label>
                          </div>

                          <div style={styles.actionGroup}>
                            <label style={styles.actionLabel}>
                              <input
                                type="radio"
                                name={`action-${detection.id}`}
                                checked={f?.action === 'remove'}
                                onChange={() => handleAction(detection.id, 'remove')}
                              />
                              <span style={{ marginLeft: '8px' }}>✕ Remove (False Positive)</span>
                            </label>
                          </div>

                          <div style={styles.actionGroup}>
                            <label style={styles.actionLabel}>
                              <input
                                type="radio"
                                name={`action-${detection.id}`}
                                checked={f?.action === 'change_severity'}
                                onChange={() => handleAction(detection.id, 'change_severity')}
                              />
                              <span style={{ marginLeft: '8px' }}>~ Change Severity</span>
                            </label>

                            {f?.action === 'change_severity' && (
                              <div style={styles.severityOptions}>
                                <label>
                                  <input
                                    type="radio"
                                    name={`severity-${detection.id}`}
                                    checked={f?.newSeverity === 'hard'}
                                    onChange={() => handleSeverityChange(detection.id, 'hard')}
                                  />
                                  <span style={{ marginLeft: '8px' }}>🚫 Hard (Cut entire scene)</span>
                                </label>
                                <label style={{ marginTop: '8px' }}>
                                  <input
                                    type="radio"
                                    name={`severity-${detection.id}`}
                                    checked={f?.newSeverity === 'soft'}
                                    onChange={() => handleSeverityChange(detection.id, 'soft')}
                                  />
                                  <span style={{ marginLeft: '8px' }}>📦 Soft (Blur/Box region)</span>
                                </label>
                              </div>
                            )}
                          </div>

                          <div style={styles.actionGroup}>
                            <label style={styles.actionLabel}>
                              Notes:
                              <textarea
                                style={styles.notesInput}
                                placeholder="e.g., 'This is false positive - intro scene'"
                                value={f?.notes || ''}
                                onChange={(e) => handleNotes(detection.id, e.target.value)}
                              />
                            </label>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {swearDetections.length > 0 && (
          <>
            <h3 style={styles.sectionTitle}>🔤 Profanity Detections ({swearDetections.length})</h3>
            <div style={styles.detectionList}>
              {swearDetections.map((detection) => {
                const f = feedback.find(fb => fb.id === detection.id);
                const isExpanded = expandedId === detection.id;

                return (
                  <div key={detection.id} style={styles.detectionCard}>
                    <div
                      style={{
                        ...styles.detectionHeader,
                        backgroundColor:
                          f?.action === 'remove'
                            ? '#2a2020'
                            : '#1f2a1f',
                      }}
                      onClick={() => setExpandedId(isExpanded ? null : detection.id)}
                    >
                      <span style={styles.detectionTime}>{detection.time}</span>
                      <span style={styles.detectionText}>{detection.text}</span>
                      <span style={styles.expandIcon}>{isExpanded ? '▼' : '▶'}</span>
                    </div>

                    {isExpanded && (
                      <div style={styles.detectionExpanded}>
                        <div style={styles.actionGroup}>
                          <label style={styles.actionLabel}>
                            <input
                              type="radio"
                              name={`action-${detection.id}`}
                              checked={f?.action === 'keep'}
                              onChange={() => handleAction(detection.id, 'keep')}
                            />
                            <span style={{ marginLeft: '8px' }}>✓ Keep (Correct)</span>
                          </label>
                        </div>

                        <div style={styles.actionGroup}>
                          <label style={styles.actionLabel}>
                            <input
                              type="radio"
                              name={`action-${detection.id}`}
                              checked={f?.action === 'remove'}
                              onChange={() => handleAction(detection.id, 'remove')}
                            />
                            <span style={{ marginLeft: '8px' }}>✕ Remove (Not Profanity)</span>
                          </label>
                        </div>

                        <div style={styles.actionGroup}>
                          <label style={styles.actionLabel}>
                            Notes:
                            <textarea
                              style={styles.notesInput}
                              placeholder="Additional context..."
                              value={f?.notes || ''}
                              onChange={(e) => handleNotes(detection.id, e.target.value)}
                            />
                          </label>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div style={{marginTop: '24px', paddingTop: '24px', borderTop: '1px solid #30363d'}}>
          <h3 style={styles.sectionTitle}>➕ Add Missing Scene</h3>
          {!showAddManual ? (
            <button 
              onClick={() => setShowAddManual(true)}
              style={{...styles.buttonSkip, backgroundColor: '#1f3a3a'}}
            >
              + Add Scene You Detected
            </button>
          ) : (
            <div style={{backgroundColor: '#161b22', padding: '16px', borderRadius: '6px', border: '1px solid #30363d'}}>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', marginBottom: '4px', fontSize: '13px'}}>
                  Start Time (seconds):
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={manualStart}
                  onChange={(e) => setManualStart(e.target.value)}
                  placeholder="e.g., 1234.5"
                  style={{width: '100%', padding: '8px', backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '4px', color: '#c9d1d9', fontFamily: 'monospace'}}
                />
              </div>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', marginBottom: '4px', fontSize: '13px'}}>
                  End Time (seconds):
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={manualEnd}
                  onChange={(e) => setManualEnd(e.target.value)}
                  placeholder="e.g., 1240.5"
                  style={{width: '100%', padding: '8px', backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '4px', color: '#c9d1d9', fontFamily: 'monospace'}}
                />
              </div>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', marginBottom: '8px', fontSize: '13px'}}>
                  Severity:
                </label>
                <div style={{display: 'flex', gap: '16px'}}>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer'}}>
                    <input
                      type="radio"
                      name="manual-severity"
                      checked={manualSeverity === 'hard'}
                      onChange={() => setManualSeverity('hard')}
                    />
                    <span>🚫 Hard (Cut scene)</span>
                  </label>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer'}}>
                    <input
                      type="radio"
                      name="manual-severity"
                      checked={manualSeverity === 'soft'}
                      onChange={() => setManualSeverity('soft')}
                    />
                    <span>📦 Soft (Blur/Box)</span>
                  </label>
                </div>
              </div>
              <div style={{marginBottom: '12px'}}>
                <label style={{display: 'block', marginBottom: '4px', fontSize: '13px'}}>
                  Notes:
                </label>
                <textarea
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  placeholder="e.g., 'Explicit scene at 12:34'"
                  style={{width: '100%', padding: '8px', backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '4px', color: '#c9d1d9', fontFamily: 'monospace', minHeight: '60px'}}
                />
              </div>
              <div style={{display: 'flex', gap: '8px'}}>
                <button 
                  onClick={handleAddManual}
                  style={{...styles.buttonSubmit}}
                >
                  Add Scene
                </button>
                <button 
                  onClick={() => setShowAddManual(false)}
                  style={{...styles.buttonSkip}}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {feedback.filter(f => f.action === 'add').length > 0 && (
            <div style={{marginTop: '12px', padding: '12px', backgroundColor: '#1f2a1f', borderRadius: '4px', border: '1px solid #30363d', fontSize: '13px'}}>
              ✅ {feedback.filter(f => f.action === 'add').length} scene(s) added for review
            </div>
          )}
        </div>
      </div>

      <div style={styles.footer}>
        <button style={styles.buttonSkip} onClick={onSkip}>
          Skip Review
        </button>
        <button style={styles.buttonSubmit} onClick={() => onSubmit(feedback)}>
          Submit Feedback & Continue
        </button>
      </div>
    </div>
  );
};

const styles = {
  container: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    height: 'auto',
    backgroundColor: '#0d1117',
    color: '#c9d1d9',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  header: {
    padding: '20px 24px',
    borderBottom: '1px solid #30363d',
  },
  title: {
    margin: '0 0 8px 0',
    fontSize: '24px',
    fontWeight: '600',
  },
  subtitle: {
    margin: 0,
    fontSize: '14px',
    color: '#8b949e',
  },
  statsBar: {
    display: 'flex' as const,
    gap: '20px',
    padding: '12px 24px',
    backgroundColor: '#161b22',
    borderBottom: '1px solid #30363d',
  },
  stat: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  statLabel: {
    fontSize: '13px',
    color: '#8b949e',
  },
  statValue: {
    fontSize: '16px',
    fontWeight: '600',
    color: '#79c0ff',
  },
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '24px',
  },
  sectionTitle: {
    fontSize: '16px',
    fontWeight: '600',
    marginTop: '0px',
    marginBottom: '12px',
    color: '#c9d1d9',
  },
  detectionList: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
    marginBottom: '24px',
  },
  detectionCard: {
    border: '1px solid #30363d',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  detectionHeader: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '12px',
    padding: '12px 16px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    transition: 'background-color 0.2s',
  },
  detectionTime: {
    fontSize: '13px',
    color: '#79c0ff',
    fontWeight: '600',
    minWidth: '80px',
  },
  detectionText: {
    flex: 1,
    fontSize: '14px',
  },
  detectionConfidence: {
    fontSize: '12px',
    color: '#8b949e',
    minWidth: '50px',
    textAlign: 'right' as const,
  },
  expandIcon: {
    fontSize: '12px',
    color: '#8b949e',
    minWidth: '20px',
    textAlign: 'center' as const,
  },
  detectionExpanded: {
    padding: '16px',
    backgroundColor: '#0d1117',
    borderTop: '1px solid #30363d',
  },
  detectionInfo: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
    marginBottom: '16px',
    fontSize: '13px',
    color: '#8b949e',
    paddingBottom: '12px',
    borderBottom: '1px solid #30363d',
  },
  detectionActions: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '12px',
  },
  actionGroup: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
  },
  actionLabel: {
    display: 'flex' as const,
    alignItems: 'flex-start' as const,
    fontSize: '13px',
    cursor: 'pointer',
    color: '#c9d1d9',
  },
  severityOptions: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
    marginLeft: '24px',
    marginTop: '8px',
    paddingLeft: '12px',
    borderLeft: '2px solid #30363d',
  },
  notesInput: {
    width: '100%',
    padding: '8px',
    marginTop: '8px',
    backgroundColor: '#161b22',
    border: '1px solid #30363d',
    borderRadius: '4px',
    color: '#c9d1d9',
    fontFamily: 'inherit',
    fontSize: '12px',
    minHeight: '60px',
    resize: 'vertical' as const,
  },
  footer: {
    display: 'flex' as const,
    gap: '12px',
    padding: '20px 24px',
    backgroundColor: '#161b22',
    borderTop: '1px solid #30363d',
    justifyContent: 'flex-end' as const,
  },
  buttonSkip: {
    padding: '8px 16px',
    backgroundColor: '#21262d',
    border: '1px solid #30363d',
    borderRadius: '6px',
    color: '#c9d1d9',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500',
    transition: 'background-color 0.2s',
  },
  buttonSubmit: {
    padding: '8px 24px',
    backgroundColor: '#238636',
    border: 'none',
    borderRadius: '6px',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500',
    transition: 'background-color 0.2s',
  },
};

export default ReviewScreen;
