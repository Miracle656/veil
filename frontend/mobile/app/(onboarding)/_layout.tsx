import { Stack } from 'expo-router';

import { useTransitions } from '../../lib/transitions';

export default function OnboardingLayout() {
  const transitions = useTransitions();
  return <Stack screenOptions={{ headerShown: false, animation: transitions.stack }} />;
}
