import React, { useState, useEffect, useRef } from 'react';
import { 
  Folder, FileText, FileCode, FileImage, FileDown, 
  ChevronRight, ChevronLeft, Search, CheckCircle2, 
  X, AlertTriangle, Sparkles, Bot, User, Send, 
  MessageSquare, ListTodo, FileIcon, ShieldCheck,
  MoreVertical, FileArchive, Settings, ChevronDown
} from 'lucide-react';

// --- Mock Data ---
const mockProjects = [
  { id: 1, name: '客户A项目', path: '~/work/customer-a' },
  { id: 2, name: 'Doc77 源码', path: '~/dev/doc77' },
];

const mockFileSystem = {
  name: 'root',
  type: 'folder',
  children: [
    {
      name: '技术文档', type: 'folder', children: [
        { name: 'API设计.md', type: 'file', icon: FileText, size: '24 KB', date: '今天 10:30' },
        { name: '架构图.mermaid', type: 'file', icon: FileCode, size: '12 KB', date: '昨天 14:00' },
        { name: '废弃接口.md', type: 'file', icon: FileArchive, size: '8 KB', date: '2026-07-01' },
      ]
    },
    {
      name: '资源文件', type: 'folder', children: [
        { name: 'logo.png', type: 'file', icon: FileImage, size: '1.2 MB', date: '2026-06-20' },
        { name: '演示视频_超大.mp4', type: 'file', icon: FileDown, size: '120 MB', date: '2026-06-21' },
      ]
    },
    { name: 'README.md', type: 'file', icon: FileText, size: '5 KB', date: '2026-07-05' },
    { name: '.doc77ignore', type: 'file', icon: FileCode, size: '1 KB', isIgnored: true, date: '2026-05-01' },
  ]
};

const mockTasks = [
  { id: 't1', type: 'create_folder', path: '技术文档/archive', status: 'pending' },
  { id: 't2', type: 'delete_file', path: '技术文档/废弃接口.md', status: 'pending', shadowProtected: true },
  { id: 't3', type: 'write_file', path: '演示视频_超大.mp4', status: 'pending', warning: '超大文件(120MB)，覆盖无法自动回滚' }
];

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState('files'); // files, chat, queue
  const [tasks, setTasks] = useState(mockTasks);
  
  // File Browser State
  const [currentPath, setCurrentPath] = useState([{ name: '客户A项目', node: mockFileSystem }]);
  const [previewFile, setPreviewFile] = useState(null);
  const [chatContext, setChatContext] = useState(null);

  // Chat State
  const [chatMessage, setChatMessage] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const chatEndRef = useRef(null);

  const currentFolder = currentPath[currentPath.length - 1].node;

  const navigateTo = (node) => {
    if (node.type === 'folder') {
      setCurrentPath([...currentPath, { name: node.name, node }]);
    } else {
      setPreviewFile(node);
    }
  };

  const navigateBack = () => {
    if (currentPath.length > 1) {
      setCurrentPath(currentPath.slice(0, -1));
    }
  };

  const startChatWithContext = (file) => {
    setChatContext(file);
    setPreviewFile(null);
    setActiveTab('chat');
    // Add a system context message if starting fresh
    if (chatHistory.length === 0) {
       setChatHistory([{ role: 'ai', content: `我已经读取了 ${file.name} 的内容。请问有什么我可以帮您分析或修改的吗？` }]);
    }
  };

  const handleSendMessage = () => {
    if (!chatMessage.trim()) return;
    setChatHistory([...chatHistory, { role: 'user', content: chatMessage }]);
    setChatMessage('');
    setTimeout(() => {
      setChatHistory(prev => [...prev, { role: 'ai', content: '操作建议已生成，请前往审批流查看。' }]);
    }, 800);
  };

  const simulateTask = (id) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'approved' } : t));
    setTimeout(() => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'executing' } : t)), 400);
    setTimeout(() => setTasks(prev => prev.map(t => t.id === id ? { ...t, status: 'executed' } : t)), 1500);
  };

  useEffect(() => {
    if (activeTab === 'chat' && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, activeTab]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-200 p-4 sm:p-8">
      {/* 模拟手机外框 (Device Frame) */}
      <div className="w-full max-w-[400px] h-[850px] bg-white rounded-[3rem] shadow-2xl border-[8px] border-slate-900 relative overflow-hidden flex flex-col">
        
        {/* 顶部状态栏 & 刘海 (Notch) */}
        <div className="h-7 w-full bg-transparent absolute top-0 z-50 flex justify-center">
          <div className="w-32 h-6 bg-slate-900 rounded-b-2xl"></div>
        </div>

        {/* --- MAIN CONTENT AREA --- */}
        <div className="flex-1 overflow-hidden bg-slate-50 pt-8 flex flex-col relative">
          
          {/* TAB 1: FILES BROWSER */}
          <div className={`absolute inset-0 flex flex-col transition-transform duration-300 ${activeTab === 'files' ? 'translate-x-0' : '-translate-x-full'}`}>
            
            {/* Header */}
            <div className="px-5 py-4 bg-white sticky top-0 z-10">
              {currentPath.length === 1 ? (
                <div className="flex justify-between items-center">
                  <div>
                    <h1 className="text-xl font-bold text-slate-900 flex items-center gap-1.5">
                      <div className="w-6 h-6 rounded-md bg-blue-600 text-white flex items-center justify-center">
                        <Folder size={14} />
                      </div>
                      客户A项目
                      <ChevronDown size={18} className="text-slate-400" />
                    </h1>
                    <p className="text-xs text-slate-500 mt-1">12 个文件 · 本地已同步</p>
                  </div>
                  <div className="flex gap-3 text-slate-700">
                    <Search size={22} className="active:scale-95 transition-transform" />
                    <Settings size={22} className="active:scale-95 transition-transform" />
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <button onClick={navigateBack} className="p-2 -ml-2 rounded-full active:bg-slate-100 transition-colors">
                    <ChevronLeft size={24} className="text-slate-700" />
                  </button>
                  <h1 className="text-lg font-bold text-slate-900 truncate flex-1">{currentPath[currentPath.length - 1].name}</h1>
                  <MoreVertical size={20} className="text-slate-700" />
                </div>
              )}
            </div>

            {/* File List */}
            <div className="flex-1 overflow-y-auto px-4 pb-24">
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100/50 overflow-hidden mt-2">
                {currentFolder.children.map((item, idx) => {
                  const Icon = item.icon || Folder;
                  const isFolder = item.type === 'folder';
                  return (
                    <div 
                      key={idx}
                      onClick={() => navigateTo(item)}
                      className="flex items-center gap-4 p-4 border-b border-slate-50 last:border-0 active:bg-slate-50 transition-colors cursor-pointer"
                    >
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
                        <Icon size={20} className={item.isIgnored ? 'opacity-40' : ''} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`font-semibold text-[15px] truncate ${item.isIgnored ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                          {item.name}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-xs text-slate-400 font-medium">
                          {isFolder ? `${item.children.length} 项` : item.size}
                          {!isFolder && <span>· {item.date}</span>}
                        </div>
                      </div>
                      {isFolder && <ChevronRight size={18} className="text-slate-300 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* TAB 2: AI CHAT */}
          <div className={`absolute inset-0 flex flex-col bg-white transition-transform duration-300 ${activeTab === 'chat' ? 'translate-x-0' : (activeTab === 'files' ? 'translate-x-full' : '-translate-x-full')}`}>
            
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10">
              <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Sparkles size={20} className="text-blue-500" />
                Doc77 助手
              </h1>
              <MoreVertical size={20} className="text-slate-700" />
            </div>

            {/* Context Badge */}
            {chatContext && (
              <div className="bg-blue-50/80 px-4 py-2 flex items-center justify-between text-xs font-medium text-blue-800 shadow-sm border-b border-blue-100">
                <span className="flex items-center gap-1.5 truncate">
                  <FileText size={14} className="text-blue-500 shrink-0" />
                  当前上下文: {chatContext.name}
                </span>
                <button onClick={() => setChatContext(null)} className="p-1 hover:bg-blue-100 rounded-full"><X size={14}/></button>
              </div>
            )}

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6 pb-24">
              {chatHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4">
                  <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center mb-4">
                    <Bot size={32} />
                  </div>
                  <h2 className="text-lg font-bold text-slate-800 mb-2">有什么我可以帮忙的？</h2>
                  <p className="text-sm text-slate-500 mb-8">我可以帮您阅读文档、分析结构，或生成批量整理操作建议。</p>
                  
                  <div className="w-full space-y-3">
                    <button className="w-full text-left p-4 bg-slate-50 hover:bg-slate-100 rounded-2xl text-sm font-medium text-slate-700 transition-colors border border-slate-100 shadow-sm" onClick={() => setChatMessage("分析项目结构并整理")}>
                      📂 智能分析项目结构并归类
                    </button>
                    <button className="w-full text-left p-4 bg-slate-50 hover:bg-slate-100 rounded-2xl text-sm font-medium text-slate-700 transition-colors border border-slate-100 shadow-sm" onClick={() => setChatMessage("生成 README 摘要")}>
                      📝 总结当前项目的主要内容
                    </button>
                  </div>
                </div>
              ) : (
                chatHistory.map((msg, i) => (
                  <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 shadow-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-slate-800 text-white'}`}>
                      {msg.role === 'user' ? <User size={16} /> : <Sparkles size={16} />}
                    </div>
                    <div className={`p-3.5 rounded-2xl text-[15px] max-w-[80%] leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm shadow-sm' : 'bg-slate-100 text-slate-800 rounded-tl-sm'}`}>
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input Area */}
            <div className="absolute bottom-20 left-0 right-0 p-4 bg-white border-t border-slate-100">
              <div className="relative flex items-center">
                <input 
                  type="text" 
                  className="w-full bg-slate-100 border-none rounded-full pl-5 pr-12 py-3.5 text-[15px] focus:ring-2 focus:ring-blue-500 transition-all outline-none"
                  placeholder="输入指令..."
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                />
                <button 
                  onClick={handleSendMessage}
                  disabled={!chatMessage.trim()}
                  className="absolute right-2 p-2 bg-blue-600 text-white rounded-full disabled:opacity-40 disabled:bg-slate-400 active:scale-95 transition-all shadow-md"
                >
                  <Send size={18} />
                </button>
              </div>
            </div>
          </div>

          {/* TAB 3: QUEUE */}
          <div className={`absolute inset-0 flex flex-col bg-slate-50 transition-transform duration-300 ${activeTab === 'queue' ? 'translate-x-0' : 'translate-x-full'}`}>
            
            {/* Header */}
            <div className="px-5 py-4 sticky top-0 z-10 bg-slate-50">
              <h1 className="text-2xl font-bold text-slate-900 mb-1">待审批操作</h1>
              <p className="text-sm text-slate-500">
                {tasks.filter(t => t.status === 'pending').length} 项任务等待执行
              </p>
            </div>

            {/* Tasks List */}
            <div className="flex-1 overflow-y-auto px-4 pb-24 space-y-4 pt-2">
              {tasks.map(task => (
                <div key={task.id} className={`bg-white rounded-[1.25rem] p-5 shadow-sm border transition-all ${
                  task.status === 'executed' ? 'border-emerald-200 bg-emerald-50/30 opacity-70' : 
                  task.status === 'rejected' ? 'border-slate-200 bg-slate-50 opacity-50' : 
                  task.warning ? 'border-red-200 shadow-[0_4px_20px_-5px_rgba(239,68,68,0.1)]' : 'border-slate-100'
                }`}>
                  
                  {/* Task Header */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {task.type === 'create_folder' && <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded-md text-[11px] font-bold">创建目录</span>}
                      {task.type === 'write_file' && <span className="bg-purple-100 text-purple-700 px-2 py-1 rounded-md text-[11px] font-bold">写入覆盖</span>}
                      {task.type === 'delete_file' && <span className="bg-red-100 text-red-700 px-2 py-1 rounded-md text-[11px] font-bold">删除文件</span>}
                    </div>
                    {task.status === 'executed' && <span className="text-xs font-bold text-emerald-600 flex items-center gap-1"><CheckCircle2 size={14}/>已执行</span>}
                    {task.status === 'rejected' && <span className="text-xs font-bold text-slate-400">已拒绝</span>}
                    {task.status === 'executing' && <span className="text-xs font-bold text-blue-600 animate-pulse">执行中...</span>}
                  </div>

                  {/* Task Path */}
                  <div className="text-sm text-slate-700 font-medium break-all leading-tight mb-4">
                    {task.path}
                  </div>

                  {/* Warnings & Security Badges */}
                  {task.warning && task.status === 'pending' && (
                    <div className="mb-4 text-xs text-red-700 bg-red-50 p-3 rounded-xl flex gap-2 leading-relaxed font-medium">
                      <AlertTriangle size={16} className="shrink-0 text-red-500 mt-0.5" />
                      {task.warning}
                    </div>
                  )}
                  {task.shadowProtected && task.status === 'pending' && (
                     <div className="mb-4 text-[11px] text-emerald-700 bg-emerald-50/80 px-3 py-2 rounded-lg flex items-center gap-1.5 font-medium">
                       <ShieldCheck size={14} className="text-emerald-500" />
                       已受 Shadow 事务保护，支持回滚
                     </div>
                  )}

                  {/* Action Buttons */}
                  {task.status === 'pending' && (
                    <div className="flex gap-3">
                      <button 
                        onClick={() => simulateTask(task.id)}
                        className="flex-1 bg-slate-900 text-white py-3 rounded-xl text-[15px] font-semibold active:scale-95 transition-transform flex items-center justify-center gap-2 shadow-md"
                      >
                        <CheckCircle2 size={18} /> 批准执行
                      </button>
                      <button 
                        onClick={() => handleReject(task.id)}
                        className="p-3 bg-slate-100 text-slate-600 rounded-xl active:bg-slate-200 active:scale-95 transition-all"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* --- BOTTOM NAVIGATION BAR --- */}
        <div className="absolute bottom-0 w-full bg-white/90 backdrop-blur-xl border-t border-slate-100 pb-5 pt-2 px-6 flex justify-between items-center z-40">
          <NavItem 
            icon={<Folder size={24} />} 
            label="文件" 
            isActive={activeTab === 'files'} 
            onClick={() => setActiveTab('files')} 
          />
          <NavItem 
            icon={<Sparkles size={24} />} 
            label="AI 助手" 
            isActive={activeTab === 'chat'} 
            onClick={() => setActiveTab('chat')} 
          />
          <NavItem 
            icon={<ListTodo size={24} />} 
            label="审批" 
            isActive={activeTab === 'queue'} 
            onClick={() => setActiveTab('queue')} 
            badge={tasks.filter(t => t.status === 'pending').length}
          />
        </div>

        {/* --- FULL SCREEN MODAL: FILE PREVIEW --- */}
        <div className={`absolute inset-0 bg-white z-50 flex flex-col transition-transform duration-400 ease-out-expo ${previewFile ? 'translate-y-0' : 'translate-y-full'}`}>
          {previewFile && (
            <>
              {/* Modal Header */}
              <div className="px-4 py-4 flex justify-between items-center bg-white border-b border-slate-100">
                <button onClick={() => setPreviewFile(null)} className="p-2 -ml-2 text-slate-700 active:bg-slate-100 rounded-full">
                   <ChevronDown size={24} />
                </button>
                <div className="font-semibold text-slate-900 text-center truncate px-2">{previewFile.name}</div>
                <button className="p-2 -mr-2 text-slate-700 active:bg-slate-100 rounded-full">
                  <MoreVertical size={20} />
                </button>
              </div>
              
              {/* Document Content */}
              <div className="flex-1 overflow-y-auto p-6 bg-slate-50">
                <div className="prose prose-sm prose-slate mx-auto">
                  <h1 className="text-2xl font-bold mb-4">{previewFile.name.replace('.md', '')} 规范</h1>
                  <p className="text-slate-600 mb-4">本文档定义了客户A项目中核心微服务的 API 交互规范。所有新接口必须遵循此标准。</p>
                  
                  <h3 className="text-lg font-semibold mt-6 mb-2">1. 全局约定</h3>
                  <ul className="list-disc pl-5 space-y-1 text-slate-700">
                    <li>基于 HTTP/1.1 与 HTTP/2 协议</li>
                    <li>数据传输格式统一为 <code>application/json</code></li>
                  </ul>

                  <h3 className="text-lg font-semibold mt-6 mb-2">2. 状态码</h3>
                  <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm mt-3">
                     <div className="flex justify-between border-b pb-2 mb-2">
                       <span className="font-medium">200 OK</span>
                       <span className="text-green-600">成功</span>
                     </div>
                     <div className="flex justify-between">
                       <span className="font-medium">400 Bad Request</span>
                       <span className="text-red-600">参数错误</span>
                     </div>
                  </div>
                </div>
              </div>

              {/* Modal FAB (Floating Action Button) */}
              <div className="absolute bottom-10 right-6 z-50">
                <button 
                  onClick={() => startChatWithContext(previewFile)}
                  className="bg-slate-900 text-white w-14 h-14 rounded-full flex items-center justify-center shadow-xl active:scale-90 transition-transform"
                >
                  <Sparkles size={24} />
                </button>
              </div>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// Bottom Nav Item Component
function NavItem({ icon, label, isActive, onClick, badge }) {
  return (
    <div onClick={onClick} className="relative flex flex-col items-center justify-center w-16 h-12 cursor-pointer group">
      <div className={`transition-all duration-300 ${isActive ? 'text-blue-600 scale-110' : 'text-slate-400'}`}>
        {icon}
      </div>
      <span className={`text-[10px] mt-1 font-semibold transition-all duration-300 ${isActive ? 'text-blue-600 opacity-100' : 'text-slate-400 opacity-0 transform translate-y-1'}`}>
        {label}
      </span>
      {badge > 0 && (
        <span className="absolute top-0 right-1 bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full border-2 border-white">
          {badge}
        </span>
      )}
    </div>
  );
}