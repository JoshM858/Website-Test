import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import DemoOne from './demo.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoOne />
  </StrictMode>,
)
