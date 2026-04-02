import { Stack } from 'expo-router';

export default function AppLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#6d28d9' },
        headerTintColor: '#ffffff',
        headerTitleStyle: { fontWeight: '700', fontSize: 18 },
        headerBackTitle: 'Wróć',
        contentStyle: { backgroundColor: '#f9fafb' },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Projekty' }} />
      <Stack.Screen
        name="project/[id]"
        options={{ title: 'Projekt', headerBackTitle: 'Projekty' }}
      />
    </Stack>
  );
}
