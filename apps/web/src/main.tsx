import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App, createApp } from './App';
import { routes } from './routes';
import './index.css';

const { router, queryClient } = createApp(() => createBrowserRouter(routes));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
