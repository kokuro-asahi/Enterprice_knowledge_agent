import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Session } from './session';
import './styles/base.css';
import './styles/overrides.css';

createRoot(document.getElementById('root')!).render(<App session={new Session()} />);
