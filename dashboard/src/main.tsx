import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import App from './App';
import MetricsPage from './pages/MetricsPage';
import ListPage from './pages/ListPage';
import CreatePage from './pages/CreatePage';
import DetailPage from './pages/DetailPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<MetricsPage />} />
          <Route path="notifications" element={<ListPage />} />
          <Route path="notifications/:id" element={<DetailPage />} />
          <Route path="create" element={<CreatePage />} />
          <Route
            path="*"
            element={<p className="py-20 text-center text-muted-fg">Trang không tồn tại.</p>}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
