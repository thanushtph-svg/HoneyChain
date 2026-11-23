// Six role-based views, each with its own base path, navigation and route guard:
//   /beekeeper  /processor  /lab  /distributor  /admin  /consumer
// plus the public, no-login product verification pages (/verify, /verify/:code).
import { Routes, Route, Navigate } from 'react-router-dom';
import RoleLayout, { LegacyAppRedirect } from './layouts/DashboardLayout.jsx';
import Login from './pages/auth/Login.jsx';
import Register from './pages/auth/Register.jsx';
import Home from './pages/public/Home.jsx';
import VerifyBatch from './pages/public/VerifyBatch.jsx';
import NotFound from './pages/public/NotFound.jsx';
import BatchList from './pages/shared/BatchList.jsx';
import BatchDetail from './pages/shared/BatchDetail.jsx';
import AiModels from './pages/shared/AiModels.jsx';
import StaffProfile from './pages/shared/StaffProfile.jsx';
import IncomingTransfers from './pages/shared/Transfers.jsx';
// beekeeper
import BeekeeperDashboard from './pages/beekeeper/Dashboard.jsx';
import Hives from './pages/beekeeper/Hives.jsx';
import Harvests from './pages/beekeeper/Harvests.jsx';
import HarvestDetail from './pages/beekeeper/HarvestDetail.jsx';
import QrCodes from './pages/beekeeper/QrCodes.jsx';
import BeekeeperProfile from './pages/beekeeper/Profile.jsx';
// processor
import ProcessorDashboard from './pages/processor/Dashboard.jsx';
import ProcessingQueue from './pages/processor/ProcessingQueue.jsx';
import ProcessedBatches from './pages/processor/ProcessedBatches.jsx';
import ProcessorTransfers from './pages/processor/Transfers.jsx';
import ProcessingHistory from './pages/processor/ProcessingHistory.jsx';
// lab tester
import LabDashboard from './pages/lab/Dashboard.jsx';
import TestingRequests, { TestingHistory } from './pages/lab/Requests.jsx';
import LabQueue from './pages/lab/LabQueue.jsx';
import LabReports, { SubmitResults } from './pages/lab/LabReports.jsx';
import LabReportPage from './pages/lab/LabReportPage.jsx';
// distributor
import DistributorDashboard, { DistributorHistory } from './pages/distributor/Dashboard.jsx';
import DispatchQueue from './pages/distributor/DispatchQueue.jsx';
import Shipments, { DeliveryStatus } from './pages/distributor/Shipments.jsx';
// admin
import AdminDashboard from './pages/admin/Dashboard.jsx';
import Users from './pages/admin/Users.jsx';
import Roles from './pages/admin/Roles.jsx';
import { AdminHives, AdminHarvests, ProcessingMonitoring, LaboratoryMonitoring, DistributionMonitoring } from './pages/admin/Monitoring.jsx';
import Blockchain from './pages/admin/Blockchain.jsx';
import ActivityLogs from './pages/admin/ActivityLogs.jsx';
import Anomalies from './pages/admin/Anomalies.jsx';
import Reports from './pages/admin/Reports.jsx';
import Settings from './pages/admin/Settings.jsx';
// consumer
import { ConsumerVerify, ConsumerScan, ConsumerHistory, PublicVerify } from './pages/consumer/Consumer.jsx';

const notFound = <NotFound inApp />;

export default function App() {
  return (
    <Routes>
      {/* public */}
      <Route path="/" element={<Home />} />
      <Route path="/verify" element={<PublicVerify />} />
      <Route path="/scan" element={<Navigate to="/verify" replace />} />
      <Route path="/verify/:batchCode" element={<VerifyBatch />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/app/*" element={<LegacyAppRedirect />} />

      {/* 1. Beekeeper */}
      <Route path="/beekeeper" element={<RoleLayout role="BEEKEEPER" />}>
        <Route index element={<BeekeeperDashboard />} />
        <Route path="hives" element={<Hives />} />
        <Route path="harvests" element={<Harvests />} />
        <Route path="harvests/:harvestCode" element={<HarvestDetail />} />
        <Route path="batches" element={<BatchList title="My batches" subtitle="Batches from your hives: status, custody and laboratory results" empty="No batches yet. Create batches from a harvest." />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="qr-codes" element={<QrCodes />} />
        <Route path="profile" element={<BeekeeperProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      {/* 2. Processor */}
      <Route path="/processor" element={<RoleLayout role="PROCESSOR" />}>
        <Route index element={<ProcessorDashboard />} />
        <Route path="incoming" element={<IncomingTransfers title="Incoming batches" />} />
        <Route path="processing" element={<ProcessingQueue />} />
        <Route path="processed" element={<ProcessedBatches />} />
        <Route path="transfers" element={<ProcessorTransfers />} />
        <Route path="history" element={<ProcessingHistory />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="profile" element={<StaffProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      {/* 3. Lab Tester */}
      <Route path="/lab" element={<RoleLayout role="LAB_TESTER" />}>
        <Route index element={<LabDashboard />} />
        <Route path="requests" element={<TestingRequests />} />
        <Route path="pending" element={<LabQueue />} />
        <Route path="submit" element={<SubmitResults />} />
        <Route path="reports" element={<LabReports />} />
        <Route path="reports/new" element={<LabReportPage />} />
        <Route path="reports/:reportCode" element={<LabReportPage />} />
        <Route path="history" element={<TestingHistory />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="ai-models" element={<AiModels />} />
        <Route path="profile" element={<StaffProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      {/* 4. Distributor */}
      <Route path="/distributor" element={<RoleLayout role="DISTRIBUTOR" />}>
        <Route index element={<DistributorDashboard />} />
        <Route path="incoming" element={<IncomingTransfers title="Incoming batches" />} />
        <Route path="distribution" element={<DispatchQueue />} />
        <Route path="shipments" element={<Shipments />} />
        <Route path="delivery" element={<DeliveryStatus />} />
        <Route path="history" element={<DistributorHistory />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="profile" element={<StaffProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      {/* 5. Admin */}
      <Route path="/admin" element={<RoleLayout role="ADMIN" />}>
        <Route index element={<AdminDashboard />} />
        <Route path="users" element={<Users />} />
        <Route path="roles" element={<Roles />} />
        <Route path="hives" element={<AdminHives />} />
        <Route path="harvests" element={<AdminHarvests />} />
        <Route path="harvests/:harvestCode" element={<HarvestDetail />} />
        <Route path="batches" element={<BatchList title="Batch management" subtitle="Every batch in the system (read-only monitoring)" />} />
        <Route path="batches/:batchCode" element={<BatchDetail />} />
        <Route path="processing" element={<ProcessingMonitoring />} />
        <Route path="laboratory" element={<LaboratoryMonitoring />} />
        <Route path="laboratory/reports/:reportCode" element={<LabReportPage />} />
        <Route path="distribution" element={<DistributionMonitoring />} />
        <Route path="blockchain" element={<Blockchain />} />
        <Route path="audit-logs" element={<ActivityLogs />} />
        <Route path="anomalies" element={<Anomalies />} />
        <Route path="reports" element={<Reports />} />
        <Route path="settings" element={<Settings />} />
        <Route path="ai-models" element={<AiModels />} />
        <Route path="profile" element={<StaffProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      {/* 6. Consumer (optional account; verification itself is public) */}
      <Route path="/consumer" element={<RoleLayout role="CONSUMER" />}>
        <Route index element={<ConsumerVerify />} />
        <Route path="scan" element={<ConsumerScan />} />
        <Route path="verify/:batchCode" element={<VerifyBatch embedded />} />
        <Route path="history" element={<ConsumerHistory />} />
        <Route path="profile" element={<StaffProfile />} />
        <Route path="*" element={notFound} />
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
