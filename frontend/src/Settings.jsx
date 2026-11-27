import { useState } from 'react';
import { DEFAULT_SETTINGS, PUBLIC_HLS, validateSource } from './data/settings.js';
import { Card, PageTitle } from './ui.jsx';
import { SystemStatus } from './Monitoring.jsx';

export default function SettingsPage({ settings, updateSettings, system, players, storageError }) {
  const [draft, setDraft] = useState(settings.urls);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  function setUrl(mode, url) {
    setDraft((current) => ({ ...current, [mode]: url }));
    setError('');
    setMessage('');
  }
  function save(event) {
    event.preventDefault();
    try {
      const urls = { live: validateSource(draft.live, 'live'), vod: validateSource(draft.vod, 'vod') };
      setDraft(urls);
      updateSettings({ ...settings, urls });
      setMessage('영상 URL을 저장했습니다.');
      setError('');
    } catch (problem) {
      setError(problem.message);
    }
  }
  function restore() {
    setDraft(DEFAULT_SETTINGS.urls);
    updateSettings(DEFAULT_SETTINGS);
    setMessage('기본 설정을 복원했습니다.');
    setError('');
  }
  return <>
    <PageTitle title="설정" detail="영상 소스와 로컬 데모 표시를 관리합니다."
      action={<button className="video-source-btn" onClick={restore}>기본 설정 복원</button>} />
    {storageError && <p className="experiment-error" role="status">{storageError}</p>}
    <div className="settings-grid ui-settings-grid">
      <Card className="ui-panel">
        <form className="ui-form" noValidate onSubmit={save}>
          <h2>영상 소스</h2>
          <label htmlFor="live-url">LIVE · MediaMTX WHEP</label>
          <input type="url" id="live-url" value={draft.live} placeholder="http://localhost:8889/mystream" onChange={(event) => setUrl('live', event.target.value)} />
          <p>스트림 주소 또는 끝에 /whep이 붙은 주소를 사용할 수 있습니다.</p>
          <label htmlFor="vod-url">VOD · HLS 또는 브라우저 영상</label>
          <input type="url" id="vod-url" value={draft.vod} placeholder="http://localhost:5173/vod/team/master.m3u8" onChange={(event) => setUrl('vod', event.target.value)} />
          <div className="ui-actions">
            <button className="primary-button">영상 URL 저장</button>
            <button type="button" className="video-source-btn" onClick={() => setUrl('vod', PUBLIC_HLS)}>공개 HLS 주소 입력</button>
          </div>
          {error && <p className="experiment-error" role="alert">{error}</p>}
          {message && <p role="status">{message}</p>}
        </form>
      </Card>
      <div className="ui-stack">
        <SystemStatus system={system} players={players} urls={settings.urls} />
        <Card className="ui-panel ui-form">
          <h2>로컬 데모</h2>
          <div className="ui-switch-row"><span id="demo-switch-label">보조 영역에 데모 표시</span>
            <button type="button" role="switch" className="ui-switch" aria-labelledby="demo-switch-label" aria-checked={settings.demo}
              onClick={() => updateSettings({ ...settings, demo: !settings.demo })}><span /></button>
          </div>
          <label htmlFor="demo-interval">로컬 데모 갱신 간격</label>
          <select id="demo-interval" value={settings.refreshInterval} onChange={(event) => updateSettings({ ...settings, refreshInterval: Number(event.target.value) })}>
            {[1000, 2000, 5000].map((interval) => <option value={interval} key={interval}>{interval / 1000}초</option>)}
          </select>
          <p>이 간격은 로컬 데모 생성에 적용됩니다. 플레이어와 외부 프로브는 각자의 수집 주기를 사용합니다.</p>
        </Card>
      </div>
    </div>
  </>;
}
