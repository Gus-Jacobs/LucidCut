import React, { useState } from 'react'
import './SettingsPanel.css'

export type ImageryConfig = {
  enabled: boolean
  regionDetection: boolean
  sensitivity: number
  categories: { explicit: boolean; revealing: boolean; suggestive: boolean }
}

interface Props {
  detectSwears: boolean
  setDetectSwears: (v: boolean) => void
  swearList: string[]
  setSwearList: (v: string[]) => void
  sensitivity: number
  setSensitivity: (v: number) => void
  imagery: ImageryConfig
  setImagery: (v: ImageryConfig) => void
}

const CATEGORY_LABELS: Record<keyof ImageryConfig['categories'], { title: string; desc: string }> = {
  explicit: { title: 'Explicit nudity', desc: 'Exposed genitalia, chest, buttocks' },
  revealing: { title: 'Revealing attire', desc: 'Covered but suggestive clothing' },
  suggestive: { title: 'Suggestive', desc: 'Exposed midriff, shirtless' },
}

export default function SettingsPanel({
  detectSwears, setDetectSwears, swearList, setSwearList,
  sensitivity, setSensitivity, imagery, setImagery,
}: Props) {
  const [newSwear, setNewSwear] = useState('')

  const handleAddSwear = (e: React.FormEvent) => {
    e.preventDefault()
    const word = newSwear.trim().toLowerCase()
    if (word && !swearList.includes(word)) {
      setSwearList([...swearList, word])
      setNewSwear('')
    }
  }
  const removeSwear = (word: string) => setSwearList(swearList.filter(w => w !== word))
  const toggleCategory = (key: keyof ImageryConfig['categories']) =>
    setImagery({ ...imagery, categories: { ...imagery.categories, [key]: !imagery.categories[key] } })

  return (
    <div className="settings-panel">
      {/* WORD DETECTION */}
      <div className="settings-section">
        <label className="toggle-label">
          <input type="checkbox" checked={detectSwears} onChange={(e) => setDetectSwears(e.target.checked)} />
          <span className="toggle-text">Enable Word Detection</span>
        </label>

        {detectSwears && (
          <div className="sub-settings">
            <div className="sensitivity-slider-container">
              <div className="slider-header">
                <span>Word Matching Sensitivity</span>
                <span>{sensitivity}%</span>
              </div>
              <input type="range" min="0" max="100" value={sensitivity} onChange={(e) => setSensitivity(parseInt(e.target.value))} />
              <div className="slider-labels">
                <span>Exact Match</span><span>Fuzzy</span><span>Catch-All</span>
              </div>
            </div>

            <div className="word-list-container">
              <form onSubmit={handleAddSwear} className="keyword-input-group">
                <input type="text" value={newSwear} onChange={e => setNewSwear(e.target.value)} placeholder="Add target word..." />
                <button type="submit">Add</button>
              </form>
              <div className="keyword-list">
                {swearList.map(word => (
                  <div key={word} className="keyword-item">
                    {word} <button type="button" onClick={() => removeSwear(word)}>✕</button>
                  </div>
                ))}
                {swearList.length === 0 && <span className="muted small">No target words defined.</span>}
              </div>
            </div>
          </div>
        )}
      </div>

      <hr className="divider" />

      {/* IMAGE DETECTION (BETA) */}
      <div className="settings-section">
        <label className="toggle-label">
          <input type="checkbox" checked={imagery.enabled} onChange={(e) => setImagery({ ...imagery, enabled: e.target.checked })} />
          <span className="toggle-text">
            Enable Visual Detection <span className="beta-badge">BETA</span>
          </span>
        </label>
        <p className="beta-warning">
          Scans frames for sensitive imagery and timestamps them. Experimental — review all results before exporting.
        </p>

        {imagery.enabled && (
          <div className="sub-settings">
            <div className="imagery-grid">
              {(Object.keys(CATEGORY_LABELS) as (keyof ImageryConfig['categories'])[]).map(key => (
                <div key={key} className="imagery-item">
                  <label>
                    <input type="checkbox" checked={imagery.categories[key]} onChange={() => toggleCategory(key)} />
                    <span>
                      {CATEGORY_LABELS[key].title}
                      <br /><span style={{ fontSize: 10, color: '#8b8b95', fontWeight: 400 }}>{CATEGORY_LABELS[key].desc}</span>
                    </span>
                  </label>
                </div>
              ))}
            </div>

            <div className="sensitivity-slider-container">
              <div className="slider-header">
                <span>Detection Sensitivity</span>
                <span>{imagery.sensitivity}%</span>
              </div>
              <input type="range" min="0" max="100" value={imagery.sensitivity}
                onChange={(e) => setImagery({ ...imagery, sensitivity: parseInt(e.target.value) })} />
              <div className="slider-labels">
                <span>Only blatant</span><span>Balanced</span><span>Aggressive</span>
              </div>
            </div>

            <label className="toggle-label" style={{ paddingLeft: 0 }}>
              <input type="checkbox" checked={imagery.regionDetection}
                onChange={(e) => setImagery({ ...imagery, regionDetection: e.target.checked })} />
              <span className="toggle-text">
                Map exact regions for censor bars
                <br /><span style={{ fontSize: 10, color: '#8b8b95', fontWeight: 400 }}>
                  Locates each body part so the editor can place a bar over it. Disable for faster scene-only flags.
                </span>
              </span>
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
