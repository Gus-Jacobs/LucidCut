import React, { useState } from 'react';
import './ReviewScreen.css';
import {
  ClipboardCheck,
  ShieldAlert,
  MessageSquareWarning,
  Plus,
  Check,
  X,
  SlidersHorizontal,
  Scissors,
  Square,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  SkipForward,
} from 'lucide-react';
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
    console.log(`Review screen loaded: ${swears} profanity + ${imagery} imagery detections`)
  }, [detections])

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAddManual, setShowAddManual] = useState(false);
  const [manualStart, setManualStart] = useState('');
  const [manualEnd, setManualEnd] = useState('');
  const [manualSeverity, setManualSeverity] = useState<'hard' | 'soft'>('soft');
  const [manualNotes, setManualNotes] = useState('');

  const handleAction = (id: string, action: 'keep' | 'remove' | 'change_severity') => {
    setFeedback(prev => prev.map(f => (f.id === id ? { ...f, action } : f)));
  };

  const handleSeverityChange = (id: string, severity: 'hard' | 'soft') => {
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
        <h2 style={styles.title}>
          <ClipboardCheck size={22} color="#8b5cf6" /> Review Detections
        </h2>
        <p style={styles.subtitle}>
          Confirm or correct {detections.length} detected issues. This feedback helps improve accuracy.
        </p>
      </div>

      <div style={styles.statsBar}>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Keep</span>
          <span style={{ ...styles.statValue, color: '#34d399' }}>{stats.keep}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Remove</span>
          <span style={{ ...styles.statValue, color: '#f87171' }}>{stats.remove}</span>
        </div>
        <div style={styles.stat}>
          <span style={styles.statLabel}>Change</span>
          <span style={{ ...styles.statValue, color: '#fbbf24' }}>{stats.change}</span>
        </div>
      </div>

      <div style={styles.content}>
        {unsafeDetections.length > 0 && (
          <>
            <h3 style={styles.sectionTitle}>
              <ShieldAlert size={18} color="#f87171" /> Imagery Detections ({unsafeDetections.length})
            </h3>
            <div style={styles.detectionList}>
              {unsafeDetections.map((detection) => {
                const f = feedback.find(fb => fb.id === detection.id);
                const isExpanded = expandedId === detection.id;
                const accent =
                  f?.action === 'remove' ? '#ef4444'
                  : f?.action === 'change_severity' ? '#eab308'
                  : '#10b981';

                return (
                  <div key={detection.id} style={{ ...styles.detectionCard, borderLeft: `3px solid ${accent}` }}>
                    <div
                      style={styles.detectionHeader}
                      onClick={() => setExpandedId(isExpanded ? null : detection.id)}
                    >
                      <span style={styles.detectionTime}>{detection.time}</span>
                      <span style={styles.detectionText}>{detection.text}</span>
                      <span style={styles.detectionConfidence}>
                        {(detection.confidence * 100).toFixed(0)}%
                      </span>
                      <span style={styles.expandIcon}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                    </div>

                    {isExpanded && (
                      <div style={styles.detectionExpanded}>
                        <div style={styles.detectionInfo}>
                          <div>
                            <strong>Type:</strong> {detection.nsfw_severity}
                          </div>
                          <div>
                            <strong>Duration:</strong> {(detection.end - detection.start).toFixed(1)} seconds
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
                              <span style={styles.actionText}><Check size={15} color="#34d399" /> Keep (Correct)</span>
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
                              <span style={styles.actionText}><X size={15} color="#f87171" /> Remove (False Positive)</span>
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
                              <span style={styles.actionText}><SlidersHorizontal size={15} color="#fbbf24" /> Change Severity</span>
                            </label>

                            {f?.action === 'change_severity' && (
                              <div style={styles.severityOptions}>
                                <label style={styles.actionLabel}>
                                  <input
                                    type="radio"
                                    name={`severity-${detection.id}`}
                                    checked={f?.newSeverity === 'hard'}
                                    onChange={() => handleSeverityChange(detection.id, 'hard')}
                                  />
                                  <span style={styles.actionText}><Scissors size={15} color="#f87171" /> Hard (Cut entire scene)</span>
                                </label>
                                <label style={{ ...styles.actionLabel, marginTop: '8px' }}>
                                  <input
                                    type="radio"
                                    name={`severity-${detection.id}`}
                                    checked={f?.newSeverity === 'soft'}
                                    onChange={() => handleSeverityChange(detection.id, 'soft')}
                                  />
                                  <span style={styles.actionText}><Square size={15} color="#60a5fa" /> Soft (Blur/Box region)</span>
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
            <h3 style={styles.sectionTitle}>
              <MessageSquareWarning size={18} color="#fb923c" /> Profanity Detections ({swearDetections.length})
            </h3>
            <div style={styles.detectionList}>
              {swearDetections.map((detection) => {
                const f = feedback.find(fb => fb.id === detection.id);
                const isExpanded = expandedId === detection.id;
                const accent = f?.action === 'remove' ? '#ef4444' : '#10b981';

                return (
                  <div key={detection.id} style={{ ...styles.detectionCard, borderLeft: `3px solid ${accent}` }}>
                    <div
                      style={styles.detectionHeader}
                      onClick={() => setExpandedId(isExpanded ? null : detection.id)}
                    >
                      <span style={styles.detectionTime}>{detection.time}</span>
                      <span style={styles.detectionText}>{detection.text}</span>
                      <span style={styles.expandIcon}>
                        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
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
                            <span style={styles.actionText}><Check size={15} color="#34d399" /> Keep (Correct)</span>
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
                            <span style={styles.actionText}><X size={15} color="#f87171" /> Remove (Not Profanity)</span>
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

        <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid rgba(124,58,237,0.15)' }}>
          <h3 style={styles.sectionTitle}>
            <Plus size={18} color="#60a5fa" /> Add Missing Scene
          </h3>
          {!showAddManual ? (
            <button
              onClick={() => setShowAddManual(true)}
              style={styles.buttonGhost}
            >
              <Plus size={15} /> Add Scene You Detected
            </button>
          ) : (
            <div style={styles.manualForm}>
              <div style={{ marginBottom: '12px' }}>
                <label style={styles.fieldLabel}>Start Time (seconds):</label>
                <input
                  type="number"
                  step="0.1"
                  value={manualStart}
                  onChange={(e) => setManualStart(e.target.value)}
                  placeholder="e.g., 1234.5"
                  style={styles.numberInput}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={styles.fieldLabel}>End Time (seconds):</label>
                <input
                  type="number"
                  step="0.1"
                  value={manualEnd}
                  onChange={(e) => setManualEnd(e.target.value)}
                  placeholder="e.g., 1240.5"
                  style={styles.numberInput}
                />
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={styles.fieldLabel}>Severity:</label>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <label style={styles.actionLabel}>
                    <input
                      type="radio"
                      name="manual-severity"
                      checked={manualSeverity === 'hard'}
                      onChange={() => setManualSeverity('hard')}
                    />
                    <span style={styles.actionText}><Scissors size={15} color="#f87171" /> Hard (Cut scene)</span>
                  </label>
                  <label style={styles.actionLabel}>
                    <input
                      type="radio"
                      name="manual-severity"
                      checked={manualSeverity === 'soft'}
                      onChange={() => setManualSeverity('soft')}
                    />
                    <span style={styles.actionText}><Square size={15} color="#60a5fa" /> Soft (Blur/Box)</span>
                  </label>
                </div>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label style={styles.fieldLabel}>Notes:</label>
                <textarea
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  placeholder="e.g., 'Explicit scene at 12:34'"
                  style={{ ...styles.numberInput, minHeight: '60px', fontFamily: 'inherit' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={handleAddManual} style={styles.buttonSubmit}>
                  Add Scene
                </button>
                <button onClick={() => setShowAddManual(false)} style={styles.buttonGhost}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {feedback.filter(f => f.action === 'add').length > 0 && (
            <div style={styles.addedBanner}>
              <CheckCircle2 size={16} color="#34d399" /> {feedback.filter(f => f.action === 'add').length} scene(s) added for review
            </div>
          )}
        </div>
      </div>

      <div style={styles.footer}>
        <button style={styles.buttonGhost} onClick={onSkip}>
          <SkipForward size={15} /> Skip Review
        </button>
        <button style={styles.buttonSubmit} onClick={() => onSubmit(feedback)}>
          Submit Feedback & Continue <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
};

const styles = {
  container: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    borderRadius: '16px',
    overflow: 'hidden',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02))',
    border: '1px solid rgba(124,58,237,0.15)',
    boxShadow: '0 10px 40px rgba(3,7,18,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
    color: '#e6eef8',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif',
  },
  header: {
    padding: '22px 24px',
    borderBottom: '1px solid rgba(124,58,237,0.15)',
  },
  title: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '10px',
    margin: '0 0 8px 0',
    fontSize: '24px',
    fontWeight: 800,
    letterSpacing: '-0.01em',
  },
  subtitle: {
    margin: 0,
    fontSize: '14px',
    color: '#9fb0cc',
  },
  statsBar: {
    display: 'flex' as const,
    gap: '28px',
    padding: '14px 24px',
    background: 'rgba(255,255,255,0.02)',
    borderBottom: '1px solid rgba(124,58,237,0.12)',
  },
  stat: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  statLabel: {
    fontSize: '13px',
    color: '#9fb0cc',
  },
  statValue: {
    fontSize: '18px',
    fontWeight: 700,
  },
  content: {
    padding: '24px',
  },
  sectionTitle: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
    fontSize: '16px',
    fontWeight: 700,
    marginTop: '0px',
    marginBottom: '14px',
    color: '#e6eef8',
  },
  detectionList: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '10px',
    marginBottom: '24px',
  },
  detectionCard: {
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: '12px',
    overflow: 'hidden',
    background: 'rgba(255,255,255,0.02)',
    transition: 'border-color 0.2s',
  },
  detectionHeader: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '12px',
    padding: '13px 16px',
    cursor: 'pointer',
    userSelect: 'none' as const,
  },
  detectionTime: {
    fontSize: '13px',
    color: '#7dd3fc',
    fontWeight: 600,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    minWidth: '80px',
  },
  detectionText: {
    flex: 1,
    fontSize: '14px',
    color: '#e6eef8',
  },
  detectionConfidence: {
    fontSize: '12px',
    color: '#9fb0cc',
    minWidth: '50px',
    textAlign: 'right' as const,
  },
  expandIcon: {
    display: 'inline-flex' as const,
    color: '#9fb0cc',
    minWidth: '20px',
    justifyContent: 'center' as const,
  },
  detectionExpanded: {
    padding: '16px',
    background: 'rgba(0,0,0,0.18)',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  detectionInfo: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
    marginBottom: '16px',
    fontSize: '13px',
    color: '#9fb0cc',
    paddingBottom: '12px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
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
    alignItems: 'center' as const,
    fontSize: '13px',
    cursor: 'pointer',
    color: '#e6eef8',
  },
  actionText: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    marginLeft: '8px',
  },
  severityOptions: {
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '8px',
    marginLeft: '24px',
    marginTop: '8px',
    paddingLeft: '12px',
    borderLeft: '2px solid rgba(124,58,237,0.25)',
  },
  notesInput: {
    width: '100%',
    padding: '8px 10px',
    marginTop: '8px',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    color: '#e6eef8',
    fontFamily: 'inherit',
    fontSize: '12px',
    minHeight: '60px',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  manualForm: {
    background: 'rgba(255,255,255,0.02)',
    padding: '16px',
    borderRadius: '12px',
    border: '1px solid rgba(124,58,237,0.15)',
  },
  fieldLabel: {
    display: 'block' as const,
    marginBottom: '6px',
    fontSize: '13px',
    color: '#9fb0cc',
  },
  numberInput: {
    width: '100%',
    padding: '9px 12px',
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    color: '#e6eef8',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '13px',
    boxSizing: 'border-box' as const,
  },
  addedBanner: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
    marginTop: '12px',
    padding: '12px 14px',
    background: 'rgba(16,185,129,0.1)',
    borderRadius: '10px',
    border: '1px solid rgba(16,185,129,0.3)',
    fontSize: '13px',
    color: '#a7f3d0',
  },
  footer: {
    display: 'flex' as const,
    gap: '12px',
    padding: '20px 24px',
    background: 'rgba(255,255,255,0.02)',
    borderTop: '1px solid rgba(124,58,237,0.15)',
    justifyContent: 'flex-end' as const,
  },
  buttonGhost: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
    padding: '10px 18px',
    background: 'transparent',
    border: '1px solid rgba(124,58,237,0.3)',
    borderRadius: '12px',
    color: '#e6eef8',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600,
    transition: 'all 200ms ease',
  },
  buttonSubmit: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
    padding: '10px 22px',
    background: 'linear-gradient(135deg, #7c3aed, #3b82f6)',
    border: 'none',
    borderRadius: '12px',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600,
    boxShadow: '0 8px 20px rgba(60,30,120,0.3)',
    transition: 'all 200ms ease',
  },
};

export default ReviewScreen;
