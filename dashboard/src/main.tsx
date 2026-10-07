import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import './styles/theme.css';

/**
 * ==============================================================================
 * ĐIỂM KHỞI CHẠY GIAO DIỆN REACT 19 (main.tsx)
 * Dự án: ZT-ServerOps (do-an-co-so-nganh)
 * Phụ trách: frontend (chủ trì)
 * ==============================================================================
 */

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
