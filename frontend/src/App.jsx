import { Routes, Route, Navigate } from 'react-router-dom';
import DashboardLayout, { RequireRole } from './layouts/DashboardLayout.jsx';
import Login from './pages/auth/Login.jsx';
import Register from './pages/auth/Register.jsx';
import Home from './pages/public/Home.jsx';
import VerifyBatch from './pages/public/VerifyBatch.jsx';
import NotFound from './pages/public/NotFound.jsx';
import Overview from './pages/shared/Overview.jsx';
import BatchList from './pages/shared/BatchList.jsx';
import BatchDetail from './pages/shared/BatchDetail.jsx';
import AiModels from './pages/shared/AiModels.jsx';
import Hives from './pages/beekeeper/Hives.jsx';
import Harvests from './pages/beekeeper/Harvests.jsx';
import HarvestDetail from './pages/beekeeper/HarvestDetail.jsx';
import Profile from './pages/beekeeper/Profile.jsx';
import LabQueue from './pages/lab/LabQueue.jsx';
import LabReports from './pages/lab/LabReports.jsx';
import LabReportPage from './pages/lab/LabReportPage.jsx';
import ProcessingQueue from './pages/processor/ProcessingQueue.jsx';
import ProcessingHistory from './pages/processor/ProcessingHistory.jsx';
import DispatchQueue from './pages/distributor/DispatchQueue.jsx';
import Shipments from './pages/distributor/Shipments.jsx';
import Users from './pages/admin/Users.jsx';
import Organizations from './pages/admin/Organizations.jsx';
import Records from './pages/admin/Records.jsx';
import Anomalies from './pages/admin/Anomalies.jsx';
import Blockchain from './pages/admin/Blockchain.jsx';
import ActivityLogs from './pages/admin/ActivityLogs.jsx';

const R = (roles, el) => <RequireRole roles={roles}>{el}</RequireRole>;

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/verify/:batchCode" element={<VerifyBatch />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/app" element={<DashboardLayout />}>
        <Route index element={<Overview />} />
        <Route path="batches" element={<BatchList />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="ai-models" element={R(['LAB', 'ADMIN'], <AiModels />)} />
        <Route path="hives" element={R(['BEEKEEPER'], <Hives />)} />
        <Route path="harvests" element={R(['BEEKEEPER'], <Harvests />)} />
        <Route path="harvests/:harvestCode" element={R(['BEEKEEPER', 'ADMIN'], <HarvestDetail />)} />
        <Route path="profile" element={R(['BEEKEEPER'], <Profile />)} />
        <Route path="lab/queue" element={R(['LAB'], <LabQueue />)} />
        <Route path="lab/reports" element={R(['LAB', 'ADMIN'], <LabReports />)} />
        <Route path="lab/reports/new" element={R(['LAB'], <LabReportPage />)} />
        <Route path="lab/reports/:reportCode" element={R(['LAB', 'ADMIN'], <LabReportPage />)} />
        <Route path="processing/queue" element={R(['PROCESSOR'], <ProcessingQueue />)} />
        <Route path="processing" element={R(['PROCESSOR', 'ADMIN'], <ProcessingHistory />)} />
        <Route path="distribution/queue" element={R(['DISTRIBUTOR'], <DispatchQueue />)} />
        <Route path="shipments" element={R(['DISTRIBUTOR', 'ADMIN'], <Shipments />)} />
        <Route path="admin" element={<Navigate to="/app" replace />} />
        <Route path="admin/users" element={R(['ADMIN'], <Users />)} />
        <Route path="admin/organizations" element={R(['ADMIN'], <Organizations />)} />
        <Route path="admin/records" element={R(['ADMIN'], <Records />)} />
        <Route path="admin/anomalies" element={R(['ADMIN'], <Anomalies />)} />
        <Route path="admin/blockchain" element={R(['ADMIN'], <Blockchain />)} />
        <Route path="admin/logs" element={R(['ADMIN'], <ActivityLogs />)} />
        <Route path="*" element={<NotFound inApp />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
