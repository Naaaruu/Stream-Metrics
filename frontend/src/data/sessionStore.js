const DB_NAME = 'stream-metrics';
const STORE = 'experiments';

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    if (!factory) {
      reject(new Error('브라우저의 IndexedDB를 사용할 수 없습니다.'));
      return;
    }
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('다른 탭에서 실험 저장소를 사용 중입니다.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function access(factory, mode, action) {
  const database = await openDatabase(factory);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('실험 저장이 중단됐습니다.'));
    });
  } finally {
    database.close();
  }
}

export async function listSessions(factory = globalThis.indexedDB) {
  const sessions = await access(factory, 'readonly', (store) => store.getAll());
  return sessions.sort((a, b) => b.startAt - a.startAt);
}

export function storeSession(session, factory = globalThis.indexedDB) {
  return access(factory, 'readwrite', (store) => store.put(session));
}

export async function renameSession(id, name, factory = globalThis.indexedDB) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) throw new Error('실험 이름을 1~100자로 입력하세요.');
  const stored = await access(factory, 'readwrite', (store) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const session = request.result;
      if (session) {
        session.name = trimmed;
        store.put(session);
      }
    };
    return request;
  });
  if (!stored) throw new Error('이름을 변경할 저장 기록을 찾을 수 없습니다.');
  return stored;
}

export function deleteSession(id, factory = globalThis.indexedDB) {
  return access(factory, 'readwrite', (store) => store.delete(id));
}
