import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * useState nhưng tự lưu vào bộ nhớ trình duyệt (localStorage).
 * - Người dùng nhập gì thì lưu lại, tải lại trang vẫn còn.
 * - Người dùng xoá trắng thì lưu luôn "trống" → mở lại vẫn trống (KHÔNG tự điền lại giá trị cũ/mặc định),
 *   trừ khi người dùng nhập lại.
 */
export function usePersistentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      // bỏ qua, dùng giá trị mặc định
    }
    return initial;
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // bộ nhớ đầy / bị chặn → bỏ qua, ứng dụng vẫn chạy
    }
  }, [key, value]);
  return [value, setValue];
}
