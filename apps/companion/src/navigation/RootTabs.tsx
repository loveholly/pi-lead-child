import { Slot } from 'expo-router';

import { FirstRunGate } from '@/features/onboarding/FirstRunGate';

export default function RootTabs() {
  return <FirstRunGate><Slot /></FirstRunGate>;
}
