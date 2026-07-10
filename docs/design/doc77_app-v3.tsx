import React, { useState, useEffect, useRef } from 'react';
import { 
  Folder, FileText, FileCode, FileImage, FileDown, 
  ChevronRight, ChevronLeft, Search, MoreVertical, 
  Settings, Clock, LayoutGrid, List as ListIcon, 
  ArrowLeft, Share, Moon, Sun, Type, ListTree,
  FileArchive, ChevronDown, Check, RefreshCw, X
} from 'lucide-react';

// --- Mock Data ---
const mockFileSystem = {
  name: 'root',
  type: 'folder',
  children: [
    {
      name: '技术文档', type: 'folder', children: [
        {
          name: 'V2 版本草稿', type: 'folder', children: [
            { name: 'API_v2_draft.md', type: 'file', size: '42 KB', date: '刚才', content: 'markdown' },
            { name: '新架构演进图.mermaid', type: 'file', size: '15 KB', date: '昨天 18:00' },
          ]
        },
        { name: 'API设计.md', type: 'file', size: '24 KB', date: '今天 10:30', content: 'markdown' },
        { name: '架构图.mermaid', type: 'file', size: '12 KB', date: '昨天 14:00' },
        { name: '废弃接口.md', type: 'file', size: '8 KB', date: '2026-07-01' },
      ]
    },
    {
      name: '资源文件', type: 'folder', children: [
        { name: '产品说明书.pdf', type: 'file', size: '3.5 MB', date: '上周', content: 'pdf' },
        { name: '产品Logo_高清.png', type: 'file', size: '4.2 MB', date: '2026-06-20', content: 'image' },
        { name: '演示视频_超大.mp4', type: 'file', size: '120 MB', date: '2026-06-21' },
      ]
    },
    { name: 'README.md', type: 'file', size: '5 KB', date: '2026-07-05', content: 'markdown' },
    { name: '.doc77ignore', type: 'file', size: '1 KB', isIgnored: true, date: '2026-05-01' },
  ]
};

// 动态图标映射
const getFileIcon = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return FileText;
  if (lower.endsWith('.png') || lower.endsWith('.jpg')) return FileImage;
  if (lower.endsWith('.mp4')) return FileDown;
  if (lower.endsWith('.mermaid')) return FileCode;
  if (lower.endsWith('.pdf')) return FileText;
  if (lower.endsWith('ignore')) return FileCode;
  return FileText;
};

// 默认最近文件（防空载）
const defaultRecent = [
  { name: 'API设计.md', size: '24 KB', date: '刚刚', path: '客户A项目 / 技术文档', timestamp: Date.now() },
  { name: '产品Logo_高清.png', size: '4.2 MB', date: '2 小时前', path: '客户A项目 / 资源文件', timestamp: Date.now() - 7200000 },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('browse');
  const [viewMode, setViewMode] = useState('list');
  
  // File Browser State
  const [currentPath, setCurrentPath] = useState([{ name: '客户A项目', node: mockFileSystem }]);
  const [previewFile, setPreviewFile] = useState(null);
  
  // Recent Files (Persisted)
  const [recentFiles, setRecentFiles] = useState(() => {
    try {
      const saved = localStorage.getItem('doc77_recent_files');
      if (saved) return JSON.parse(saved);
    } catch(e) {}
    return defaultRecent;
  });
  
  // Refined Features State
  const [isLandscape, setIsLandscape] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isBreadcrumbOpen, setIsBreadcrumbOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Reader State
  const [readerTheme, setReaderTheme] = useState('light');
  const [showToc, setShowToc] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  
  // Touch Gestures State
  const [touchStartX, setTouchStartX] = useState(0);
  const [touchStartY, setTouchStartY] = useState(0);
  const scrollContainerRef = useRef(null);

  const currentFolder = currentPath[currentPath.length - 1].node;

  // 监听横竖屏切换 (设备旋转)
  useEffect(() => {
    const mediaQuery = window.matchMedia('(orientation: landscape)');
    setIsLandscape(mediaQuery.matches);
    
    const handleOrientationChange = (e) => setIsLandscape(e.matches);
    mediaQuery.addEventListener('change', handleOrientationChange);
    return () => mediaQuery.removeEventListener('change', handleOrientationChange);
  }, []);

  const filteredFiles = currentFolder.children?.filter(item => 
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const navigateTo = (node) => {
    if (node.type === 'folder') {
      setCurrentPath([...currentPath, { name: node.name, node }]);
      setSearchQuery('');
      setIsSearchOpen(false);
    } else {
      setPreviewFile(node);
      setReaderTheme('light');
      setShowToc(false);
      setScrollProgress(0);
      
      // 更新最近浏览记录
      const newRecord = {
        name: node.name,
        size: node.size,
        date: '刚刚',
        path: currentPath.map(p => p.name).join(' / '),
        timestamp: Date.now()
      };
      
      setRecentFiles(prev => {
        const filtered = prev.filter(f => f.name !== node.name);
        const updated = [newRecord, ...filtered].slice(0, 10); // 仅保留最近10条
        localStorage.setItem('doc77_recent_files', JSON.stringify(updated));
        return updated;
      });
    }
  };

  const navigateBack = () => {
    if (currentPath.length > 1) {
      setCurrentPath(currentPath.slice(0, -1));
      setSearchQuery('');
      setIsSearchOpen(false);
    }
  };

  const jumpToDepth = (depth) => {
    setCurrentPath(currentPath.slice(0, depth + 1));
    setIsBreadcrumbOpen(false);
    setSearchQuery('');
    setIsSearchOpen(false);
  };

  // 进度条计算
  const handleReaderScroll = (e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollHeight <= clientHeight) {
      setScrollProgress(0);
      return;
    }
    const progress = (scrollTop / (scrollHeight - clientHeight)) * 100;
    setScrollProgress(progress);
  };

  // 手势处理
  const handleTouchStart = (e) => {
    setTouchStartX(e.touches ? e.touches[0].clientX : e.clientX);
    setTouchStartY(e.touches ? e.touches[0].clientY : e.clientY);
  };

  const handleTouchEnd = (e) => {
    const endX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const endY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const deltaX = endX - touchStartX;
    const deltaY = endY - touchStartY;

    if (deltaX > 80 && Math.abs(deltaY) < 50 && currentPath.length > 1 && !previewFile) {
      navigateBack();
    }
    if (deltaY > 80 && Math.abs(deltaX) < 50 && !previewFile) {
      const scrollPos = scrollContainerRef.current?.scrollTop || 0;
      if (scrollPos <= 0) {
        setIsRefreshing(true);
        setTimeout(() => setIsRefreshing(false), 1200);
      }
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-800 p-4 sm:p-8 font-sans">
      
      {/* 模拟手机外框 (响应式宽高切换) */}
      <div 
        className={`bg-slate-50 rounded-[3rem] shadow-2xl border-[8px] border-slate-900 relative overflow-hidden flex flex-col transition-all duration-500 ease-in-out ${isLandscape ? 'w-full max-w-[850px] h-[400px]' : 'w-full max-w-[400px] h-[850px]'}`}
      >
        
        {/* 刘海 */}
        <div className={`bg-slate-900 absolute z-50 flex justify-center pointer-events-none transition-all duration-500 ${isLandscape ? 'w-6 h-32 left-0 top-1/2 -translate-y-1/2 rounded-r-2xl' : 'h-6 w-32 top-0 left-1/2 -translate-x-1/2 rounded-b-2xl'}`}></div>

        {/* --- MAIN CONTENT AREA --- */}
        <div 
          className={`flex-1 overflow-hidden flex flex-col relative bg-slate-50 ${isLandscape ? 'pl-8' : 'pt-8'}`}
          onMouseDown={handleTouchStart}
          onMouseUp={handleTouchEnd}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          
          {/* TAB 1: RECENT */}
          <div className={`absolute inset-0 flex flex-col transition-all duration-300 ${activeTab === 'recent' ? 'translate-x-0 opacity-100 z-10' : '-translate-x-10 opacity-0 pointer-events-none'} ${isLandscape ? 'pl-8' : 'pt-8'}`}>
            <div className="px-6 py-4 bg-slate-50 sticky top-0">
              <h1 className="text-2xl font-bold text-slate-900 mt-2">最近浏览</h1>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-24">
              <div className="space-y-3 mt-2">
                {recentFiles.map((file, idx) => {
                  const Icon = getFileIcon(file.name);
                  return (
                    <div key={idx} onClick={() => setPreviewFile(file)} className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4 active:scale-95 transition-transform cursor-pointer">
                      <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                        <Icon size={24} strokeWidth={1.5} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-[15px] text-slate-800 truncate">{file.name}</div>
                        <div className="text-xs text-slate-400 mt-1 truncate">{file.path}</div>
                      </div>
                      <div className="text-xs font-medium text-slate-400 shrink-0">{file.date}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* TAB 2: BROWSE */}
          <div className={`absolute inset-0 flex flex-col transition-all duration-300 ${activeTab === 'browse' ? 'translate-x-0 opacity-100 z-10' : (activeTab === 'recent' ? 'translate-x-10 opacity-0' : '-translate-x-10 opacity-0')} ${isLandscape ? 'pl-8' : 'pt-8'}`}>
            
            {/* Header */}
            <div className="px-5 py-4 bg-slate-50 sticky top-0 z-20">
              {currentPath.length === 1 ? (
                <div className="flex justify-between items-center mt-2 h-10">
                  {!isSearchOpen ? (
                    <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">浏览</h1>
                  ) : (
                    <div className="flex-1 relative mr-3 animate-fade-in">
                      <Search size={18} className="absolute left-3 top-2.5 text-slate-400" />
                      <input 
                        type="text" 
                        autoFocus
                        placeholder="搜索项目..." 
                        className="w-full bg-white border border-slate-200 rounded-full pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                  )}
                  <button onClick={() => {setIsSearchOpen(!isSearchOpen); setSearchQuery('');}} className="p-2 bg-white rounded-full shadow-sm border border-slate-100 text-slate-600 active:bg-slate-50 shrink-0">
                    {isSearchOpen ? <X size={20} /> : <Search size={20} />}
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2 h-10 relative">
                  <button onClick={navigateBack} className="p-2 -ml-2 bg-white rounded-full shadow-sm border border-slate-100 active:bg-slate-50 transition-colors shrink-0 z-10">
                    <ChevronLeft size={22} className="text-slate-700" />
                  </button>

                  {!isSearchOpen ? (
                    <div className="flex-1 min-w-0 relative flex justify-center items-center">
                      <button 
                        onClick={() => setIsBreadcrumbOpen(!isBreadcrumbOpen)}
                        className="flex items-center gap-1 font-bold text-slate-900 text-lg hover:bg-slate-200/50 px-3 py-1 rounded-full transition-colors truncate max-w-full"
                      >
                        <span className="truncate">{currentPath[currentPath.length - 1].name}</span>
                        <ChevronDown size={18} className={`shrink-0 transition-transform ${isBreadcrumbOpen ? 'rotate-180 text-blue-600' : 'text-slate-400'}`} />
                      </button>

                      {isBreadcrumbOpen && (
                        <>
                          <div className="fixed inset-0 z-20 bg-transparent" onClick={() => setIsBreadcrumbOpen(false)}></div>
                          <div className="absolute top-12 left-1/2 -translate-x-1/2 w-56 bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-slate-200 z-30 overflow-hidden animate-fade-in-up origin-top">
                            {currentPath.map((pathNode, idx) => (
                              <button 
                                key={idx} 
                                onClick={() => jumpToDepth(idx)}
                                className={`w-full text-left px-4 py-3 flex items-center justify-between border-b border-slate-100 last:border-0 active:bg-slate-100 transition-colors ${idx === currentPath.length - 1 ? 'bg-blue-50/50' : ''}`}
                              >
                                <span className={`text-[15px] truncate font-medium ${idx === currentPath.length - 1 ? 'text-blue-600' : 'text-slate-700'}`}>
                                  {pathNode.name}
                                </span>
                                {idx === currentPath.length - 1 && <Check size={16} className="text-blue-600 shrink-0" />}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 relative animate-fade-in">
                      <Search size={18} className="absolute left-3 top-2.5 text-slate-400" />
                      <input 
                        type="text" 
                        autoFocus
                        placeholder={`在 ${currentPath[currentPath.length - 1].name} 中搜索...`} 
                        className="w-full bg-white border border-slate-200 rounded-full pl-10 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="flex gap-2 shrink-0 z-10">
                    <button onClick={() => {setIsSearchOpen(!isSearchOpen); setSearchQuery('');}} className="p-2 text-slate-600 bg-white rounded-full shadow-sm border border-slate-100">
                      {isSearchOpen ? <X size={20} /> : <Search size={20} />}
                    </button>
                    {!isSearchOpen && (
                      <button onClick={() => setViewMode(v => v === 'list' ? 'grid' : 'list')} className="p-2 text-slate-600 bg-white rounded-full shadow-sm border border-slate-100 hidden sm:block">
                        {viewMode === 'list' ? <LayoutGrid size={20} /> : <ListIcon size={20} />}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 下拉刷新指示器 */}
            <div className={`flex justify-center transition-all duration-300 overflow-hidden ${isRefreshing ? 'h-12 opacity-100' : 'h-0 opacity-0'}`}>
              <div className="flex items-center gap-2 text-blue-500 text-sm font-medium">
                <RefreshCw size={18} className="animate-spin" /> 更新缓存中...
              </div>
            </div>

            {/* 文件列表区 */}
            <div className="flex-1 overflow-y-auto px-4 pb-24" ref={scrollContainerRef}>
              
              {currentPath.length === 1 && !searchQuery && (
                <div className="mt-2 mb-6 animate-fade-in">
                  <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 px-1">本地项目</div>
                  <div 
                    onClick={() => navigateTo(mockFileSystem)}
                    className="bg-white rounded-2xl p-4 shadow-sm border border-slate-200/60 flex items-center gap-4 active:scale-95 transition-transform cursor-pointer"
                  >
                    <div className="w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-inner">
                      <Folder size={24} fill="currentColor" className="opacity-80" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-bold text-lg text-slate-800">客户A项目</h3>
                      <p className="text-xs text-slate-500 font-medium">~/work/customer-a · 12 项</p>
                    </div>
                    <ChevronRight size={20} className="text-slate-300" />
                  </div>
                </div>
              )}

              {searchQuery && filteredFiles.length === 0 && (
                <div className="text-center py-12 text-slate-400">
                  <Search size={48} className="mx-auto mb-4 opacity-20" />
                  <p>未找到匹配的文件或文件夹</p>
                </div>
              )}

              {(currentPath.length > 1 || searchQuery) && filteredFiles.length > 0 && (
                <div className="animate-fade-in-up">
                  {viewMode === 'list' || (isLandscape && currentPath.length === 1) ? ( 
                    <div className="bg-white rounded-2xl shadow-sm border border-slate-100/80 overflow-hidden mt-2">
                      {filteredFiles.map((item, idx) => {
                        const Icon = getFileIcon(item.name) || Folder;
                        const isFolder = item.type === 'folder';
                        return (
                          <div 
                            key={idx}
                            onClick={() => navigateTo(item)}
                            className="flex items-center gap-4 p-4 border-b border-slate-50 last:border-0 active:bg-slate-50 transition-colors cursor-pointer"
                          >
                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-50 text-blue-500' : 'bg-slate-50 text-slate-500'}`}>
                              <Icon size={22} strokeWidth={1.5} className={item.isIgnored ? 'opacity-40' : ''} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className={`font-semibold text-[15px] truncate ${item.isIgnored ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                                {item.name}
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400 font-medium">
                                {isFolder ? `${item.children?.length || 0} 项` : item.size}
                                {!isFolder && <span>· {item.date}</span>}
                              </div>
                            </div>
                            {isFolder && <ChevronRight size={18} className="text-slate-300 shrink-0" />}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                      {filteredFiles.map((item, idx) => {
                        const Icon = getFileIcon(item.name) || Folder;
                        const isFolder = item.type === 'folder';
                        return (
                          <div 
                            key={idx}
                            onClick={() => navigateTo(item)}
                            className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100/80 flex flex-col items-center justify-center text-center active:scale-95 transition-transform cursor-pointer aspect-square"
                          >
                            <div className={`w-14 h-14 rounded-2xl mb-3 flex items-center justify-center ${isFolder ? 'bg-blue-50 text-blue-500' : 'bg-slate-50 text-slate-500'}`}>
                              <Icon size={32} strokeWidth={1.5} className={item.isIgnored ? 'opacity-40' : ''} />
                            </div>
                            <div className={`font-semibold text-sm w-full truncate px-1 ${item.isIgnored ? 'text-slate-400 line-through' : 'text-slate-800'}`}>
                              {item.name}
                            </div>
                            <div className="text-[10px] text-slate-400 mt-1 font-medium">
                              {isFolder ? `${item.children?.length || 0} 项` : item.size}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* TAB 3: SETTINGS */}
          <div className={`absolute inset-0 flex flex-col transition-all duration-300 ${activeTab === 'settings' ? 'translate-x-0 opacity-100 z-10' : 'translate-x-10 opacity-0 pointer-events-none'} ${isLandscape ? 'pl-8' : 'pt-8'}`}>
            <div className="px-6 py-4 bg-slate-50 sticky top-0">
              <h1 className="text-2xl font-bold text-slate-900 mt-2">设置</h1>
            </div>
            <div className="p-4 space-y-4 pb-24 overflow-y-auto">
               <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
                  <div className="flex items-center gap-4 border-b border-slate-50 pb-4">
                    <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center text-slate-500">
                      <Settings size={24} />
                    </div>
                    <div>
                      <div className="font-bold text-slate-800">Doc77 预览引擎</div>
                      <div className="text-xs text-slate-500 mt-0.5">v2.5.0 (Build 20260707)</div>
                    </div>
                  </div>
                  <div className="pt-4 space-y-4">
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-slate-700">默认排版引擎</span>
                      <span className="text-sm text-blue-600">Marked v17</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-sm font-medium text-slate-700">清理缓存</span>
                      <span className="text-sm text-slate-400">12 MB</span>
                    </div>
                  </div>
               </div>
            </div>
          </div>
        </div>

        {/* --- BOTTOM NAVIGATION BAR --- */}
        <div className={`absolute bottom-0 w-full bg-white/95 backdrop-blur-xl border-t border-slate-100 pb-6 pt-3 px-8 flex justify-between items-center z-40 shadow-[0_-10px_20px_-10px_rgba(0,0,0,0.05)] transition-all ${isLandscape ? 'pl-16' : ''}`}>
          <NavItem 
            icon={<Clock size={24} strokeWidth={2} />} 
            label="最近" 
            isActive={activeTab === 'recent'} 
            onClick={() => setActiveTab('recent')} 
          />
          <NavItem 
            icon={<Folder size={24} strokeWidth={2} />} 
            label="浏览" 
            isActive={activeTab === 'browse'} 
            onClick={() => setActiveTab('browse')} 
          />
          <NavItem 
            icon={<Settings size={24} strokeWidth={2} />} 
            label="设置" 
            isActive={activeTab === 'settings'} 
            onClick={() => setActiveTab('settings')} 
          />
        </div>

        {/* ========================================================= */}
        {/* === FULL SCREEN MODAL: IMMERSIVE READER (沉浸式阅读器) === */}
        {/* ========================================================= */}
        <div 
          className={`absolute inset-0 z-50 flex flex-col transition-all duration-400 ease-out-expo ${previewFile ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'} ${readerTheme === 'dark' ? 'bg-slate-900' : 'bg-white'} ${isLandscape ? 'pl-8' : ''}`}
        >
          {previewFile && (
            <>
              {/* Progress Bar (阅读进度条) */}
              <div className="absolute top-0 left-0 w-full h-1 z-[60] bg-transparent">
                 <div 
                   className="h-full bg-blue-500 transition-all duration-150 ease-out" 
                   style={{ width: `${scrollProgress}%` }}
                 ></div>
              </div>

              {/* Reader Header */}
              <div className={`px-4 py-3 flex justify-between items-center ${isLandscape ? 'pt-4' : 'pt-10'} ${readerTheme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-100'} border-b transition-colors shrink-0 z-50`}>
                <button 
                  onClick={() => setPreviewFile(null)} 
                  className={`p-2 -ml-2 rounded-full transition-colors ${readerTheme === 'dark' ? 'text-slate-300 active:bg-slate-800' : 'text-slate-700 active:bg-slate-100'}`}
                >
                   <ArrowLeft size={24} />
                </button>
                <div className={`font-semibold text-center truncate px-2 text-[15px] ${readerTheme === 'dark' ? 'text-slate-200' : 'text-slate-900'}`}>
                  {previewFile.name}
                </div>
                <button className={`p-2 -mr-2 rounded-full transition-colors ${readerTheme === 'dark' ? 'text-slate-300 active:bg-slate-800' : 'text-slate-700 active:bg-slate-100'}`}>
                  <Share size={20} />
                </button>
              </div>
              
              {/* Reader Content */}
              <div 
                className={`flex-1 overflow-y-auto p-6 transition-colors ${readerTheme === 'dark' ? 'bg-slate-900 text-slate-300' : 'bg-white text-slate-800'}`}
                onScroll={handleReaderScroll}
              >
                
                {previewFile.name.endsWith('.mermaid') ? (
                  // Mermaid 预览占位
                  <div className={`w-full max-w-2xl mx-auto h-64 rounded-2xl flex flex-col items-center justify-center border shadow-sm ${readerTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                     <FileCode size={48} className="text-blue-500 mb-4 opacity-80" />
                     <p className={`font-medium ${readerTheme === 'dark' ? 'text-slate-300' : 'text-slate-600'}`}>Mermaid 图表渲染区</p>
                     <p className={`text-xs mt-2 font-mono ${readerTheme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>[{previewFile.name}]</p>
                  </div>
                ) : previewFile.name.endsWith('.pdf') ? (
                  // PDF 预览占位
                  <div className={`w-full max-w-2xl mx-auto min-h-[400px] rounded-2xl flex flex-col items-center justify-center border shadow-inner ${readerTheme === 'dark' ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-200/50 border-slate-300'}`}>
                     <FileText size={56} className="text-red-500 mb-4 opacity-80" />
                     <p className={`font-medium ${readerTheme === 'dark' ? 'text-slate-300' : 'text-slate-700'}`}>PDF.js 沉浸式阅读器</p>
                     <p className={`text-xs mt-2 ${readerTheme === 'dark' ? 'text-slate-500' : 'text-slate-500'}`}>共 12 页 · {previewFile.size}</p>
                     <button className={`mt-6 px-5 py-2 rounded-lg text-sm font-medium shadow-sm transition-colors ${readerTheme === 'dark' ? 'bg-slate-700 text-white hover:bg-slate-600' : 'bg-white text-slate-800 hover:bg-slate-50 border border-slate-200'}`}>
                        加载文档内容
                     </button>
                  </div>
                ) : previewFile.name.endsWith('.png') || previewFile.name.endsWith('.jpg') ? (
                  // 图片预览模式
                  <div className="w-full h-full flex flex-col items-center justify-center">
                    <div className="w-48 h-48 bg-slate-200 rounded-3xl flex items-center justify-center mb-6 shadow-inner">
                       <FileImage size={64} className="text-slate-400 opacity-50" />
                    </div>
                    <p className={`text-sm font-medium ${readerTheme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>全高清图像预览就绪</p>
                    <p className={`text-xs mt-2 ${readerTheme === 'dark' ? 'text-slate-500' : 'text-slate-400'}`}>{previewFile.size} · {previewFile.date}</p>
                  </div>
                ) : (
                  // Markdown 文档预览模式
                  <div className={`prose prose-sm mx-auto w-full max-w-2xl ${readerTheme === 'dark' ? 'prose-invert prose-headings:text-slate-100 prose-a:text-blue-400 prose-strong:text-slate-200' : 'prose-slate'}`}>
                    <div className={`text-xs font-mono mb-8 pb-4 border-b ${readerTheme === 'dark' ? 'border-slate-800 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
                      约 2,500 字 · 预计阅读时间 5 分钟
                    </div>
                    
                    <h1 className="text-3xl font-extrabold mb-6 leading-tight">
                      {previewFile.name.replace('.md', '')} 核心规范
                    </h1>
                    <p className="text-[15px] leading-relaxed opacity-90 mb-6">
                      本文档定义了客户A项目中核心微服务的 API 交互规范。在进行任何接口重构前，请务必仔细阅读并遵循本指南的所有条款。
                    </p>
                    
                    <h3 className="text-xl font-bold mt-8 mb-4">1. 全局架构约定</h3>
                    <p className="text-[15px] leading-relaxed opacity-90">
                      所有对外暴露的网关均采用无状态设计，通过 JWT 进行鉴权。
                    </p>
                    <ul className="list-disc pl-5 space-y-2 mt-4 opacity-90 text-[15px]">
                      <li>基于 <strong>HTTP/1.1</strong> 与 HTTP/2 双栈支持</li>
                      <li>数据传输格式强制统一为 <code>application/json</code></li>
                      <li>全链路字符编码采用 <code>UTF-8</code></li>
                    </ul>
                    
                    {/* 添加额外内容以便产生滚动条，测试进度条功能 */}
                    <div className="space-y-4 my-8">
                      <p>这是一段用于填充长度的段落，以确保在移动端视图下能够产生足够的滚动距离，从而测试顶部的蓝色阅读进度条功能。滑动页面时，你可以观察到顶部的进度条随着滚动比例增加而变长。</p>
                      <p>在实际的 Markdown 渲染中，这里将包含大量的 API 定义、请求示例、响应体结构以及状态码说明。</p>
                      <p>通过使用 better-sqlite3、PDF.js 和 Marked 等库，Doc77 可以在不依赖任何云端服务的情况下，提供极其流畅的本地文件解析体验。</p>
                      <p>为了保证用户体验，我们设计了完全响应式的界面，并且适配了深色模式，以降低在弱光环境下阅读技术文档的眼部疲劳。</p>
                      <p>所有的滑动和过渡动画都参考了 iOS 的原生设计规范，确保物理反馈自然且符合直觉。</p>
                    </div>

                    <h3 className="text-xl font-bold mt-10 mb-4">2. 状态码字典</h3>
                    <div className={`p-1 rounded-xl mt-4 border ${readerTheme === 'dark' ? 'border-slate-700 bg-slate-800/50' : 'border-slate-200 bg-slate-50'}`}>
                      <div className={`flex justify-between items-center p-3 border-b ${readerTheme === 'dark' ? 'border-slate-700' : 'border-slate-200'}`}>
                        <span className="font-bold font-mono">200 OK</span>
                        <span className="text-emerald-500 text-sm font-semibold flex items-center gap-1"><Check size={14}/> 请求成功</span>
                      </div>
                      <div className="flex justify-between items-center p-3">
                        <span className="font-bold font-mono">400 Bad Req</span>
                        <span className="text-red-500 text-sm font-semibold">参数校验异常</span>
                      </div>
                    </div>

                    <p className="mt-8 text-[15px] leading-relaxed opacity-90">
                      <em>注：以上规范自 v2.5.0 起强制生效，旧版接口请参考归档目录。</em>
                    </p>
                    <div className="h-32"></div> {/* Bottom Padding for Toolbar */}
                  </div>
                )}
              </div>

              {/* Reader Bottom Toolbar */}
              <div className={`absolute bottom-0 w-full px-6 pb-8 pt-4 flex justify-between items-center backdrop-blur-xl border-t transition-colors z-20 ${readerTheme === 'dark' ? 'bg-slate-900/90 border-slate-800 text-slate-300' : 'bg-white/90 border-slate-100 text-slate-600'} ${isLandscape ? 'pb-4' : ''}`}>
                
                <button onClick={() => setShowToc(!showToc)} className={`flex flex-col items-center gap-1 transition-colors ${showToc ? 'text-blue-500' : ''}`}>
                  <ListTree size={22} />
                  <span className="text-[10px] font-medium">大纲</span>
                </button>
                
                <button className="flex flex-col items-center gap-1">
                  <Type size={22} />
                  <span className="text-[10px] font-medium">排版</span>
                </button>
                
                <button onClick={() => setReaderTheme(t => t === 'light' ? 'dark' : 'light')} className="flex flex-col items-center gap-1">
                  {readerTheme === 'light' ? <Moon size={22} /> : <Sun size={22} className="text-amber-400" />}
                  <span className="text-[10px] font-medium">{readerTheme === 'light' ? '深色' : '浅色'}</span>
                </button>
              </div>

              {/* Table of Contents Drawer */}
              <div className={`absolute bottom-24 left-4 right-4 rounded-2xl shadow-2xl transition-all duration-300 ease-out-expo overflow-hidden border ${showToc ? 'translate-y-0 opacity-100 z-10' : 'translate-y-8 opacity-0 pointer-events-none z-0'} ${readerTheme === 'dark' ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'} ${isLandscape ? 'max-w-xs mx-auto bottom-20' : ''}`}>
                 <div className={`px-4 py-3 border-b text-sm font-bold ${readerTheme === 'dark' ? 'border-slate-700 text-slate-200' : 'border-slate-100 text-slate-800'}`}>
                   文档大纲
                 </div>
                 <div className="p-2">
                   <div className={`px-3 py-2 text-[13px] rounded-lg mb-1 font-medium ${readerTheme === 'dark' ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-50 text-blue-600'}`}>
                     1. 全局架构约定
                   </div>
                   <div className={`px-3 py-2 text-[13px] rounded-lg font-medium pl-6 ${readerTheme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>
                     2. 状态码字典
                   </div>
                 </div>
              </div>

            </>
          )}
        </div>

      </div>
    </div>
  );
}

// Bottom Nav Item Component
function NavItem({ icon, label, isActive, onClick }) {
  return (
    <div onClick={onClick} className="relative flex flex-col items-center justify-center w-16 h-12 cursor-pointer group">
      <div className={`transition-all duration-300 ${isActive ? 'text-blue-600 -translate-y-1' : 'text-slate-400'}`}>
        {icon}
      </div>
      <span className={`text-[10px] font-bold absolute bottom-0 transition-all duration-300 ${isActive ? 'text-blue-600 opacity-100 translate-y-2' : 'text-slate-400 opacity-0 translate-y-4'}`}>
        {label}
      </span>
      {/* 激活状态的点 */}
      <div className={`absolute -bottom-1 w-1 h-1 rounded-full bg-blue-600 transition-all duration-300 ${isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-0'}`}></div>
    </div>
  );
}