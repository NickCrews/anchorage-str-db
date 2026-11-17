import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Room } from '../room';
import { RegistrationProblems } from './RegistrationProblems';
import '../index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Room>
      <RegistrationProblems />
    </Room>
  </StrictMode>,
);
