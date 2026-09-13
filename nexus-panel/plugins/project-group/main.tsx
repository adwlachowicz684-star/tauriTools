import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import './style.css';
import App from './App';

bootIframeReactPlugin(() => <App />);
