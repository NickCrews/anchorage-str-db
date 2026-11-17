import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {Room} from './room';
import {Story} from './story/Story';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Room>
      <Story />
    </Room>
  </StrictMode>,
);
