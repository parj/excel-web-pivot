import '@mantine/core/styles.css';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import './theme.css';

import { MantineProvider, createTheme, localStorageColorSchemeManager } from '@mantine/core';
import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';

// "auto" follows the OS prefers-color-scheme; the manual toggle writes an
// override into localStorage via this manager.
const colorSchemeManager = localStorageColorSchemeManager({ key: 'excel-pivot-color-scheme' });

const theme = createTheme({
  fontFamily: "'DM Sans', system-ui, sans-serif",
  primaryColor: 'red',
  defaultRadius: 'sm',
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
      <App />
    </MantineProvider>
  </React.StrictMode>
);
